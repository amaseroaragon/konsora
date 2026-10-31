use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, mpsc, Mutex},
    time::{Duration, Instant},
};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{path::BaseDirectory, Manager};

const UNAVAILABLE: &str = "No se pudo iniciar el servicio local. Revisa la instalación y los permisos del directorio de datos.";

struct Running {
    child: Child,
    input: Option<ChildStdin>,
    token: String,
    url: String,
}

impl Drop for Running {
    fn drop(&mut self) {
        drop(self.input.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Err(_) => break,
                _ => std::thread::sleep(Duration::from_millis(25)),
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct Backend {
    running: Mutex<Option<Running>>,
    attempted: AtomicBool,
    executable: PathBuf,
    data_dir: PathBuf,
    client: Client,
}

#[derive(Deserialize)]
struct Ready { protocol: u8, port: u16 }

#[derive(Serialize)]
pub struct ApiResponse { status: u16, body: Option<Value> }

impl Backend {
    pub fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let executable = app.path().resolve("backend/backend", BaseDirectory::Resource).map_err(|_| UNAVAILABLE)?;
        let data_dir = app.path().app_data_dir().map_err(|_| UNAVAILABLE)?;
        fs::create_dir_all(&data_dir).map_err(|_| UNAVAILABLE)?;
        if fs::symlink_metadata(&data_dir).map_err(|_| UNAVAILABLE)?.file_type().is_symlink() {
            return Err(UNAVAILABLE.into());
        }
        fs::set_permissions(&data_dir, fs::Permissions::from_mode(0o700)).map_err(|_| UNAVAILABLE)?;
        let client = Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2)).timeout(Duration::from_secs(8)).build().map_err(|_| UNAVAILABLE)?;
        Ok(Self { running: Mutex::new(None), attempted: AtomicBool::new(false), executable, data_dir, client })
    }

    fn launch(&self) -> Result<Running, String> {
        let mut random = [0u8; 32];
        getrandom::fill(&mut random).map_err(|_| UNAVAILABLE)?;
        let token: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let mut child = Command::new(&self.executable).arg("--data-dir").arg(&self.data_dir).arg("--parent-stdin")
            .env_clear().env("PATH", "/usr/bin:/bin").env("LANG", "C.UTF-8")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|_| UNAVAILABLE)?;
        let input = child.stdin.take().ok_or(UNAVAILABLE)?;
        let stdout = child.stdout.take().ok_or(UNAVAILABLE)?;
        let mut running = Running { child, input: Some(input), token, url: String::new() };
        let configuration = serde_json::json!({"token": running.token});
        writeln!(running.input.as_mut().ok_or(UNAVAILABLE)?, "{configuration}").map_err(|_| UNAVAILABLE)?;
        running.input.as_mut().ok_or(UNAVAILABLE)?.flush().map_err(|_| UNAVAILABLE)?;
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = BufReader::new(stdout.take(4096)).read_line(&mut line).map(|_| line);
            let _ = sender.send(result);
        });
        let line = receiver.recv_timeout(Duration::from_secs(12)).map_err(|_| UNAVAILABLE)?.map_err(|_| UNAVAILABLE)?;
        let ready: Ready = serde_json::from_str(&line).map_err(|_| UNAVAILABLE)?;
        if ready.protocol != 1 || ready.port == 0 { return Err(UNAVAILABLE.into()); }
        running.url = format!("http://127.0.0.1:{}", ready.port);
        let deadline = Instant::now() + Duration::from_secs(8);
        while Instant::now() < deadline {
            if running.child.try_wait().map_err(|_| UNAVAILABLE)?.is_some() { return Err(UNAVAILABLE.into()); }
            if let Ok(response) = self.client.get(format!("{}/health", running.url))
                .bearer_auth(&running.token).header("Origin", "tauri://localhost").send() {
                if response.status().is_success() { return Ok(running); }
            }
            std::thread::sleep(Duration::from_millis(40));
        }
        Err(UNAVAILABLE.into())
    }

    pub fn stop(&self) {
        if let Ok(mut running) = self.running.lock() { drop(running.take()); }
    }

    fn connection(&self, restart: bool) -> Result<(String, String), String> {
        let mut guard = self.running.lock().map_err(|_| UNAVAILABLE)?;
        let alive = guard.as_mut().map(|running| matches!(running.child.try_wait(), Ok(None))).unwrap_or(false);
        if !alive {
            drop(guard.take());
            let first = !self.attempted.swap(true, Ordering::SeqCst);
            if !restart && !first { return Err("El servicio local no está disponible. Pulsa Comprobar conexión para reintentarlo.".into()); }
            *guard = Some(self.launch()?);
        }
        let running = guard.as_ref().ok_or(UNAVAILABLE)?;
        Ok((running.url.clone(), running.token.clone()))
    }

    fn request(&self, path: String, method: String, body: Option<Value>) -> Result<ApiResponse, String> {
        if !(path == "/health" || path.starts_with("/projects")) || path.contains("://") || path.contains('\\')
            || !["GET", "POST", "PATCH", "DELETE"].contains(&method.as_str()) {
            return Err("Operación local no permitida.".into());
        }
        let (url, token) = self.connection(path == "/health" && method == "GET")?;
        let method = reqwest::Method::from_bytes(method.as_bytes()).map_err(|_| "Método no válido.")?;
        let mut request = self.client.request(method, format!("{url}{path}"))
            .bearer_auth(token).header("Origin", "tauri://localhost");
        if let Some(value) = body {
            if value.to_string().len() > 8 * 1024 * 1024 { return Err("La petición local es demasiado grande.".into()); }
            request = request.json(&value);
        }
        let response = request.send().map_err(|_| "No se pudo conectar con el servicio local. Comprueba la conexión antes de repetir.")?;
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        response.take(10 * 1024 * 1024 + 1).read_to_end(&mut bytes).map_err(|_| "No se pudo leer la respuesta local.")?;
        if bytes.len() > 10 * 1024 * 1024 { return Err("La respuesta local es demasiado grande.".into()); }
        let body = if status == 204 { None } else { Some(serde_json::from_slice(&bytes).map_err(|_| "Respuesta local no válida.")?) };
        Ok(ApiResponse { status, body })
    }
}

#[tauri::command]
pub async fn api_request(window: tauri::WebviewWindow, path: String, method: String, body: Option<Value>) -> Result<ApiResponse, String> {
    let url = window.url().map_err(|_| "Ventana no válida.")?;
    let local = matches!((url.scheme(), url.host_str()), ("tauri", Some("localhost")) | ("http", Some("tauri.localhost")));
    let development = cfg!(debug_assertions) && window.app_handle().config().build.dev_url.as_ref()
        .map(|expected| expected.origin() == url.origin()).unwrap_or(false);
    if window.label() != "main" || !(local || development) { return Err("Ventana no autorizada.".into()); }
    let handle = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || handle.state::<Backend>().request(path, method, body))
        .await.map_err(|_| "El servicio local interrumpió la operación.".to_string())?
}
