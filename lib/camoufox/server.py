#!/home/karacasoft/.openclaw/.venv/bin/python3

import argparse
import base64
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from threading import Lock as ThreadLock

import orjson
import camoufox.addons as camoufox_addons
from camoufox.pkgman import LOCAL_DATA
from camoufox.utils import launch_options
from playwright._impl._driver import compute_driver_executable

LAUNCH_SCRIPT = LOCAL_DATA / "launchServer.js"

# The sandbox denies multiprocessing semaphores, but camoufox only needs a lock
# here to serialize addon setup. A thread lock is sufficient for this process.
camoufox_addons.Lock = ThreadLock


def camel_case(value: str) -> str:
    if len(value) < 2:
        return value
    chunks = value.lower().split("_")
    return chunks[0] + "".join(chunk.capitalize() for chunk in chunks[1:])


def to_camel_case(data: dict) -> dict:
    return {camel_case(key): value for key, value in data.items()}


def parse_bool(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "no", "n", "off"}:
        return False
    raise argparse.ArgumentTypeError(f"invalid boolean value: {value}")


def wait_for_port(process: subprocess.Popen, port: int, timeout: float = 45.0) -> None:
    deadline = time.time() + timeout
    last_error = None
    while time.time() < deadline:
        if process.poll() is not None:
            stdout = process.stdout.read() if process.stdout else ""
            stderr = process.stderr.read() if process.stderr else ""
            raise RuntimeError(
                f"camoufox launcher exited early (code={process.returncode}): {stderr or stdout or 'no output'}"
            )
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return
        except OSError as exc:
            last_error = exc
            time.sleep(0.25)
    raise TimeoutError(f"camoufox server did not open port {port}: {last_error}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Launch a Camoufox websocket server.")
    parser.add_argument("--port", type=int, default=19222, help="WebSocket port")
    parser.add_argument("--ws-path", default="camoufox", help="WebSocket path")
    parser.add_argument(
        "--profile-dir",
        default=os.path.expanduser("~/.camoufox-profile"),
        help="Profile directory for persistent browser state",
    )
    parser.add_argument(
        "--headless",
        type=parse_bool,
        default=True,
        help="Whether to launch headless (true/false)",
    )
    parser.add_argument(
        "--proxy",
        default=None,
        help="SOCKS5/HTTP proxy URL, for example socks5://127.0.0.1:11090",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.port <= 0 or args.port > 65535:
        parser.error("--port must be between 1 and 65535")

    try:
        profile_dir = Path(args.profile_dir).expanduser()
        profile_dir.mkdir(parents=True, exist_ok=True)

        config = launch_options(
            headless=args.headless,
            port=args.port,
            ws_path=args.ws_path,
            user_data_dir=str(profile_dir),
            proxy=args.proxy,
            host="127.0.0.1",
        )
        if config.get("proxy") is None:
            del config["proxy"]

        encoded = base64.b64encode(orjson.dumps(to_camel_case(config))).decode()

        nodejs = compute_driver_executable()[0]
        if isinstance(nodejs, tuple):
            nodejs = nodejs[0]

        process = subprocess.Popen(
            [nodejs, str(LAUNCH_SCRIPT)],
            cwd=Path(nodejs).parent / "package",
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )

        try:
            if process.stdin is None:
                raise RuntimeError("camoufox launcher stdin is unavailable")
            process.stdin.write(encoded)
            process.stdin.close()

            wait_for_port(process, args.port)
            sys.stdout.write(f"ws://127.0.0.1:{args.port}/{args.ws_path}\n")
            sys.stdout.flush()

            return process.wait()
        except KeyboardInterrupt:
            process.terminate()
            return process.wait(timeout=10)
        except Exception:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
            raise
    except Exception as exc:
        sys.stderr.write(f"camoufox server error: {exc}\n")
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
