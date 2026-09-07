#!/usr/bin/env python3
"""Disposable-host experiment, not production updater code. Never launches locally."""
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import platform
import re
import subprocess
import sys
import threading
import time
import urllib.request


def require_disposable(env, platform):
    if platform != 'darwin' or env.get('GITHUB_ACTIONS') != 'true' or env.get('RUNNER_ENVIRONMENT') != 'github-hosted':
        raise RuntimeError('This experiment requires a disposable GitHub-hosted macOS runner; refusing to launch locally')


def main():
    require_disposable(os.environ, sys.platform)
    baseline, channel = sys.argv[1:]
    if not re.fullmatch(r'v\d+\.\d+\.\d+', baseline) or channel not in ('latest', 'nightly'):
        raise ValueError('Invalid baseline or channel')
    root = Path.home() / '.ao' / 'issue4254'
    root.mkdir(parents=True, exist_ok=False)
    evidence = root / 'evidence'
    evidence.mkdir()
    artifacts = root / 'artifacts'
    artifacts.mkdir()
    log_lock = threading.Lock()
    def event(kind, **data):
        with log_lock:
            with (evidence / 'timeline.jsonl').open('a') as f:
                f.write(json.dumps({'time': time.time(), 'event': kind, **data}) + '\n')
        print(kind, json.dumps(data), flush=True)
    def command(args, log, check=True, env=None):
        with (evidence / log).open('ab') as f:
            result = subprocess.run(args, stdout=f, stderr=subprocess.STDOUT, env=env)
        event('command', argv=args, exit=result.returncode, log=log)
        if check and result.returncode:
            raise RuntimeError(f'{log}: exit {result.returncode}')
        return result.returncode
    def digest(path):
        h = hashlib.sha512()
        with path.open('rb') as f:
            for block in iter(lambda: f.read(1024 * 1024), b''):
                h.update(block)
        return base64.b64encode(h.digest()).decode()
    command(['sw_vers'], 'host.log')
    command(['uname', '-a'], 'host.log')
    repo = 'Untrivial-ai/agent-orchestrator'
    arch = {'arm64': 'arm64', 'x86_64': 'x64'}[platform.machine()]
    command(['gh', 'release', 'download', baseline, '--repo', repo, '--pattern', f'Agent.Orchestrator-darwin-{arch}-{baseline[1:]}.zip', '--pattern', 'latest-mac.yml', '--dir', str(artifacts)], 'download.log')
    archive = artifacts / f'Agent.Orchestrator-darwin-{arch}-{baseline[1:]}.zip'
    manifest = (artifacts / 'latest-mac.yml').read_text()
    match = re.search(rf'url:.*darwin-{arch}.*\n\s+sha512:\s*(\S+)', manifest)
    if not match or digest(archive) != match[1]:
        raise RuntimeError('Baseline archive does not match release manifest')
    (evidence / 'baseline-manifest.yml').write_text(manifest)
    event('baseline-hash', sha512=digest(archive), size=archive.stat().st_size, tag=baseline)
    installed = Path('/Applications')
    app = installed / 'Agent Orchestrator.app'
    if app.exists():
        raise RuntimeError('Refusing to replace an existing app, even on this disposable runner')
    command(['ditto', '-x', '-k', str(archive), str(installed)], 'extract.log')
    plist = app / 'Contents/Info.plist'
    def version():
        return plistlib.loads(plist.read_bytes())['CFBundleShortVersionString']
    def verify(label):
        # Canonical verifier executes all trust checks before its runtime smoke.
        # v0.12.0 predates the modern ACP Node bundle requirement. Accept ONLY
        # that explicitly identified non-signature compatibility failure.
        name = label + '-verification.log'
        status = command(['bash', 'frontend/scripts/verify-mac-artifact.sh', str(app)], name, check=False)
        text = (evidence / name).read_text()
        failures = [line for line in text.splitlines() if line.startswith('::error::')]
        legacy_checks = {'v0.12.0': 'ACP Node is bundled failed', 'v0.12.10': 'ACP Node allow-jit entitlement failed'}
        legacy_gap = label == 'baseline' and baseline in legacy_checks and len(failures) == 1 and legacy_checks[baseline] in failures[0]
        if status and not legacy_gap:
            raise RuntimeError(f'{label} failed canonical artifact verification')
        for check in ('codesign', 'spctl', 'stapler'):
            if 'ok: ' + check not in text:
                raise RuntimeError(f'{label}: missing successful {check}')
        event('artifact-verified', label=label, legacy_runtime_check_omitted=failures if legacy_gap else [])
    verify('baseline')
    event('baseline-inspected', version=version(), sentinel=b'AO_E2E_UPDATE_SENTINEL' in (app / 'Contents/Resources/app.asar').read_bytes())
    (evidence / 'baseline-app-update.yml').write_bytes((app / 'Contents/Resources/app-update.yml').read_bytes())
    # Native and package cache state resolves under ~/.ao, even though native
    # APIs refer to the platform cache locations. This is a fresh runner only.
    caches = Path.home() / 'Library/Caches'
    caches.mkdir(exist_ok=True)
    native = root / 'native-cache'
    package = root / 'package-cache'
    for name, target in [('dev.agent-orchestrator.desktop.ShipIt', native), ('agent-orchestrator-updater', package)]:
        link = caches / name
        if link.exists() or link.is_symlink():
            raise RuntimeError(f'Refusing existing updater cache: {link}')
        target.mkdir()
        link.symlink_to(target, target_is_directory=True)
    state = root / 'state'
    state.mkdir()
    runfile = state / 'running.json'
    (state / 'update-settings.json').write_text(json.dumps({'enabled': True, 'channel': channel, 'nightlyAck': channel == 'nightly', 'feature': None}))
    # Observers are installed BEFORE launching. Snapshots are best-effort and
    # explicitly not atomic: native code may remove a failed directory itself.
    stop = threading.Event()
    seen = set()
    snapshots = evidence / 'snapshots'
    snapshots.mkdir()
    def observer():
        while not stop.wait(0.15):
            try:
                for directory in native.glob('update.*'):
                    if not directory.is_dir():
                        continue
                    bundles = list(directory.glob('*.app'))
                    milestones = [('appeared', True)]
                    if bundles:
                        milestones += [('bundle', True), ('seal', (bundles[0] / 'Contents/_CodeSignature/CodeResources').exists())]
                    for milestone, exists in milestones:
                        key = (str(directory), milestone)
                        if exists and key not in seen:
                            seen.add(key)
                            dest = snapshots / (directory.name + '-' + milestone)
                            command(['cp', '-cR', str(directory), str(dest)], 'snapshot.log', check=False)
                            event('snapshot-best-effort', source=str(directory), destination=str(dest), milestone=milestone)
                for source in native.glob('*'):
                    if source.is_file() and source.suffix in ('.plist', '.log'):
                        try:
                            (evidence / source.name).write_bytes(source.read_bytes())
                        except OSError:
                            pass
            except Exception as exc:
                event('observer-error', error=str(exc))
    thread = threading.Thread(target=observer, daemon=True)
    thread.start()
    env = {k: v for k, v in os.environ.items() if k not in ('GH_TOKEN', 'GITHUB_TOKEN', 'AO_DATA_DIR', 'AO_RUN_FILE', 'AO_PORT')}
    env.update(AO_DATA_DIR=str(state / 'data'), AO_RUN_FILE=str(runfile), AO_PORT='3317', ELECTRON_ENABLE_LOGGING='1')
    children = []
    def launch(label):
        executable = plistlib.loads(plist.read_bytes())['CFBundleExecutable']
        output = (evidence / (label + '.log')).open('wb')
        child = subprocess.Popen([str(app / 'Contents/MacOS' / executable)], env=env, stdout=output, stderr=subprocess.STDOUT)
        output.close()
        children.append(child)
        event('launch', pid=child.pid, version=version(), app=str(app))
        return child
    def quit_exact(child):
        if child.poll() is not None:
            return
        # Target the application by PID; never by its generic application name.
        script = f'tell application "System Events" to tell application process whose unix id is {child.pid} to click menu item "Quit Agent Orchestrator" of menu 1 of menu bar item 1 of menu bar 1'
        status = command(['osascript', '-e', script], 'quit.log', check=False)
        if status:
            # NSRunningApplication delivers a normal application termination
            # request to this PID; SIGTERM is not used as proof of install-on-quit.
            code = f'import AppKit\nlet app = NSRunningApplication(processIdentifier: {child.pid})\nif app?.terminate() != true {{ exit(1) }}\n'
            swift = root / 'quit.swift'
            swift.write_text(code)
            command(['swift', str(swift)], 'quit.log')
        child.wait(timeout=60)
    result = {'baseline': baseline, 'channel': channel, 'outcome': 'incomplete', 'exact_historical_target_pinned': False}
    try:
        child = launch('baseline-app')
        deadline = time.monotonic() + 600
        staged = None
        while time.monotonic() < deadline:
            text = (evidence / 'baseline-app.log').read_text(errors='replace')
            if re.search(r'did not pass validation|failed to get static code for bundle', text, re.I):
                result['outcome'] = 'signature-rejection-observed'
                event('signature-rejection-observed')
                raise RuntimeError('Observed target signature-rejection symptom; preserving evidence without retry')
            statefile = native / 'ShipItState.plist'
            if statefile.exists():
                try:
                    info = json.loads(subprocess.check_output(['plutil', '-convert', 'json', '-o', '-', str(statefile)], stderr=subprocess.DEVNULL))
                except (subprocess.CalledProcessError, ValueError, OSError):
                    # Native state may be observed part-way through a write;
                    # plutil also handles formats outside plistlib's XML/binary.
                    time.sleep(0.2)
                    continue
                url = info.get('updateBundleURL', '')
                if url:
                    from urllib.parse import urlparse, unquote
                    candidate = Path(unquote(urlparse(url).path))
                    if candidate.exists():
                        staged = candidate
                        try:
                            result['native_staged_version'] = plistlib.loads((candidate / 'Contents/Info.plist').read_bytes())['CFBundleShortVersionString']
                        except (OSError, ValueError, plistlib.InvalidFileException):
                            time.sleep(0.2)
                            continue
                        event('native-armed', bundle=str(candidate), version=result['native_staged_version'])
                        command(['cp', '-cR', str(candidate), str(snapshots / 'native-armed.app')], 'snapshot.log', check=False)
                        break
            if child.poll() is not None:
                raise RuntimeError(f'Baseline exited before native staging: {child.returncode}')
            time.sleep(1)
        if staged is None:
            raise RuntimeError('No native staged bundle after 600 seconds; not classified as signature reproduction')
        if result['native_staged_version'] == baseline[1:]:
            raise RuntimeError('Native candidate is not a version change')
        for cached in package.rglob('*.zip'):
            stat_before = cached.stat()
            h = digest(cached)
            stat_after = cached.stat()
            event('cached-archive-hash', path=str(cached), sha512=h, size=stat_after.st_size, stable_during_hash=(stat_before.st_mtime_ns, stat_before.st_size) == (stat_after.st_mtime_ns, stat_after.st_size))
        quit_exact(child)
        deadline = time.monotonic() + 180
        while version() != result['native_staged_version'] and time.monotonic() < deadline:
            time.sleep(1)
        if version() != result['native_staged_version']:
            raise RuntimeError('Native stage succeeded but application swap did not land')
        verify('installed')
        old_run = runfile.read_bytes() if runfile.exists() else None
        relaunched = launch('updated-app')
        deadline = time.monotonic() + 120
        alive = False
        while time.monotonic() < deadline:
            if runfile.exists() and runfile.read_bytes() != old_run:
                handshake = json.loads(runfile.read_text())
                try:
                    with urllib.request.urlopen(f'http://127.0.0.1:{handshake["port"]}/healthz', timeout=3) as response:
                        alive = response.status == 200
                except Exception:
                    pass
            if alive and relaunched.poll() is None:
                break
            time.sleep(1)
        if not alive or relaunched.poll() is not None:
            raise RuntimeError('Updated application did not demonstrate fresh daemon liveness')
        result.update(outcome='update-hop-passed', installed_version=version())
        quit_exact(relaunched)
    except Exception as exc:
        result['error'] = str(exc)
        event('experiment-error', error=str(exc))
    finally:
        # Failure cleanup never requests a normal quit, which could install and
        # overwrite the evidence. Only this runner's captured children are killed.
        for child in children:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=30)
        stop.set()
        thread.join(timeout=30)
        for directory in (native, package):
            command(['ditto', str(directory), str(evidence / directory.name)], 'final-capture.log', check=False)
        daemonlog = Path.home() / '.ao/daemon.log'
        if daemonlog.exists():
            (evidence / 'daemon.log').write_bytes(daemonlog.read_bytes())
        (evidence / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
        event('result', **result)
    if result['outcome'] != 'update-hop-passed':
        raise SystemExit(1)


if __name__ == '__main__':
    main()
