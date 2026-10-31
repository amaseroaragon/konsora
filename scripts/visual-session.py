#!/usr/bin/env python3
"""Run an existing Konsora binary in a disposable local X11/DBus session."""
import argparse
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def child(run, binary):
    with (run / 'app.log').open('w') as log:
        app = subprocess.Popen([str(binary)], cwd=ROOT, stdout=log, stderr=log)
        def terminate(_signal, _frame):
            stop(app)
        signal.signal(signal.SIGTERM, terminate)
        manifest = {'pid': app.pid, 'run': str(run), 'env': {
            key: os.environ[key] for key in ('DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR')
        }}
        (run / 'session.json').write_text(json.dumps(manifest))
        try:
            return app.wait()
        finally:
            stop(app)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, default=ROOT / 'apps/desktop/src-tauri/target/release/konsora-desktop')
    parser.add_argument('--child', type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    binary = args.binary.resolve()
    if not binary.is_file():
        parser.error('Compila Konsora primero o indica --binary.')
    if args.child:
        return child(args.child, binary)
    xvfb = shutil.which('Xvfb') or str(ROOT / '.tools/xvfb/root/usr/bin/Xvfb')
    if not Path(xvfb).is_file():
        parser.error('Falta Xvfb; consulta docs/automatizacion-local.md.')
    base = ROOT / '.local/visual-sessions'
    base.mkdir(parents=True, exist_ok=True)
    run = Path(tempfile.mkdtemp(dir=base))
    env = dict(os.environ, GDK_BACKEND='x11', NO_AT_BRIDGE='0')
    for key, leaf in [('XDG_DATA_HOME', 'data'), ('XDG_CONFIG_HOME', 'config'),
                      ('XDG_CACHE_HOME', 'cache'), ('XDG_RUNTIME_DIR', 'run')]:
        path = run / leaf
        path.mkdir(mode=0o700)
        env[key] = str(path)
    with (run / 'session.log').open('w') as log:
        server = subprocess.Popen([xvfb, '-displayfd', '1', '-screen', '0', '1600x1000x24',
                                   '-nolisten', 'tcp'], stdout=subprocess.PIPE, stderr=log)
        session = None
        try:
            if not select.select([server.stdout], [], [], 10)[0]:
                raise RuntimeError('Xvfb no respondió; revisar session.log')
            number = server.stdout.readline().decode().strip()
            if not number.isdigit():
                raise RuntimeError('Xvfb no inició una pantalla')
            env['DISPLAY'] = ':' + number
            session = subprocess.Popen(['dbus-run-session', '--', sys.executable, __file__,
                                        '--child', str(run), '--binary', str(binary)],
                                       env=env, cwd=ROOT, stdout=log, stderr=log, start_new_session=True)
            print(f'Sesión: {run / "session.json"}\nCtrl+C cierra solo esta instancia. Datos y capturas quedan en {run}', flush=True)
            return session.wait()
        except KeyboardInterrupt:
            return 0
        finally:
            if session is not None and session.poll() is None:
                os.killpg(session.pid, signal.SIGTERM)
                try:
                    session.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    os.killpg(session.pid, signal.SIGKILL)
                    session.wait()
            stop(server)


if __name__ == '__main__':
    raise SystemExit(main())
