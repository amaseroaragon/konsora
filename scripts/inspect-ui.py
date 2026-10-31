#!/usr/bin/env python3
"""Inspect/click Konsora via AT-SPI; capture an isolated X11 test window."""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
target = parser.add_mutually_exclusive_group(required=True)
target.add_argument('--pid', type=int, help='PID de la ventana real; solo tree/click')
target.add_argument('--session', type=Path, help='session.json creado por visual-session.py')
parser.add_argument('action', choices=['tree', 'click', 'shot'])
parser.add_argument('value', nargs='?', help='Nombre accesible exacto o nombre de captura .png')
args = parser.parse_args()
if args.action != 'tree' and not args.value:
    parser.error('La acción requiere un valor.')
record = None
if args.session:
    record = json.loads(args.session.read_text())
    for key in ('DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'):
        os.environ[key] = record['env'][key]
    pid = record['pid']
else:
    pid = args.pid

import gi

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi

Atspi.init()


def walk(node):
    yield node
    for index in range(node.get_child_count()):
        child = node.get_child_at_index(index)
        if child:
            yield from walk(child)


def main():
    desktop = Atspi.get_desktop(0)
    apps = [desktop.get_child_at_index(i) for i in range(desktop.get_child_count())]
    app = next((n for n in apps if n.get_process_id() == pid and n.get_name() == 'konsora-desktop'), None)
    if app is None:
        raise RuntimeError('Konsora no está accesible con ese PID/sesión.')
    if args.action == 'tree':
        for node in walk(app):
            name = node.get_name()
            text = Atspi.Text.get_text(node, 0, -1) if 'Text' in node.get_interfaces() else ''
            if name or text:
                print(f'{node.get_role_name()}: {name!r} {text[:240]!r}')
    elif args.action == 'click':
        matches = [n for n in walk(app) if n.get_name() == args.value and
                   n.get_role_name() in ('push button', 'check box', 'unknown', 'toggle button', 'menu item') and
                   'Action' in n.get_interfaces() and Atspi.Action.get_n_actions(n) > 0]
        if len(matches) != 1:
            raise RuntimeError(f'Se requiere un control inequívoco; encontrados: {len(matches)}')
        node = matches[0]
        if not node.get_state_set().contains(Atspi.StateType.ENABLED):
            raise RuntimeError('El control está deshabilitado.')
        if not Atspi.Action.do_action(node, 0):
            raise RuntimeError('La acción no se pudo solicitar.')
        print('Acción solicitada. Ejecuta tree para verificar el estado resultante.')
    else:
        if record is None:
            raise RuntimeError('Las capturas requieren una sesión Xvfb; en Wayland usa el portal de capturas.')
        filename = Path(args.value)
        if filename.name != args.value or filename.suffix != '.png':
            raise RuntimeError('Usa un nombre simple acabado en .png.')
        output = Path(record['run']) / filename
        if output.exists():
            raise RuntimeError('La captura ya existe; elige otro nombre.')
        listing = subprocess.check_output(['xwininfo', '-root', '-tree'], text=True)
        windows = re.findall(r'(0x[0-9a-f]+) "Konsora"', listing)
        if len(windows) != 1:
            raise RuntimeError('No hay una única ventana de Konsora en esta pantalla.')
        subprocess.run(['import', '-window', windows[0], str(output)], check=True)
        print(output)


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
