# Runs inside a Colab runtime that K itself created, sent by K through the official
# execute_code tool. Every step is idempotent (verified markers) and k_relay never
# runs the same inference twice. K never sends a step again: each call runs inside
# k_step, which records the step's terminal state under its executionId, and when
# the call's own answer fails or is lost K only reads that record (k_state, in a
# separate session). Weights come straight from the publisher at a fixed
# revision and are checked file by file; nothing is quantized or down-converted.
# UNVERIFIED on a real runtime (2026-11-13: no runtime may be started yet). The
# heartbeats assume Colab streams stdout as progress, as the execute_code page says.
import hashlib, http.client, json, os, re, shlex, shutil, subprocess, sys, tarfile, threading, time, urllib.error, urllib.parse, urllib.request

K = '/content/k'
STATE = os.path.join(K, 'state')
PORT = 8399
_OUT = None  # K_ marker lines of the step k_step is recording


def _say(*parts):
    line = ' '.join(str(part) for part in parts)
    print(line, flush=True)
    if _OUT is not None and line.startswith('K_'):
        _OUT.append(line)


def _write(path, value):
    with open(path + '.part', 'w') as out:
        json.dump(value, out)
    os.replace(path + '.part', path)


def k_step(step_id, run):
    # Claimed exclusively: if Colab ever started this executionId again (the
    # official page: reusing one after its result was returned starts a new
    # execution), the step is not run a second time.
    global _OUT
    os.makedirs(STATE, exist_ok=True)
    path = os.path.join(STATE, step_id + '.json')
    try:
        os.close(os.open(path + '.claim', os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except FileExistsError:
        raise RuntimeError('K_STEP_DUPLICATE')
    _write(path, {'id': step_id, 'state': 'running', 'pid': os.getpid()})
    _OUT = []
    try:
        run()
    except BaseException as error:
        found = re.search(r'\bK_[A-Z][A-Z_]{1,40}\b', str(error))
        _write(path, {'id': step_id, 'state': 'failed', 'name': type(error).__name__, 'marker': found.group(0) if found else None})
        raise
    finally:
        out, _OUT = _OUT, None
    _write(path, {'id': step_id, 'state': 'done', 'out': out})


def k_state(step_id):
    # Read-only. absent: never claimed; claimed: claimed, first record not yet
    # written; running (kernel process alive); dead (it ended without a terminal
    # record); done / failed: terminal.
    path = os.path.join(STATE, step_id + '.json')
    try:
        value = json.load(open(path))
    except FileNotFoundError:
        value = {'state': 'claimed' if os.path.exists(path + '.claim') else 'absent'}
    if value.get('state') == 'running' and not os.path.exists('/proc/%d' % value.get('pid', 0)):
        value = {'state': 'dead'}
    # Names the step it describes, so K never reads it as another execution's.
    value['id'] = step_id
    print('K_STATE', json.dumps(value), flush=True)


def k_launch(step_id, program):
    # Execute long preparation outside the short-lived Colab kernel call.
    os.makedirs(STATE, exist_ok=True)
    script = os.path.join(STATE, step_id + '.py')
    with open(script, 'x', encoding='utf-8') as out:
        out.write(program)
    try:
        subprocess.Popen([sys.executable, script], stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    except OSError:
        _write(os.path.join(STATE, step_id + '.json'),
               {'id': step_id, 'state': 'failed', 'name': 'OSError', 'marker': 'K_PREPARE_LAUNCH_FAILED'})
        raise


def _run(command):
    # Stream child output through the kernel so the execute_code stream stays alive.
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in process.stdout:
        print(line.rstrip()[:300], flush=True)
    if process.wait() != 0:
        raise RuntimeError('K_STEP_FAILED %s %s' % (command[0], process.returncode))


def k_prepare():
    for sub in ('req', 'res', 'models', 'run', 'src'):
        os.makedirs(os.path.join(K, sub), exist_ok=True)
    gpu = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.total', '--format=csv,noheader'],
                         capture_output=True, text=True).stdout.strip()
    _say('K_GPU', gpu or 'none')
    _say('K_DISK_FREE', shutil.disk_usage('/content').free)


def k_fetch(repository, revision, directory, files):
    base = os.path.join(K, 'models', directory)
    for item in files:
        target = os.path.join(base, *item['path'].split('/'))
        marker = target + '.k-verified'
        if os.path.exists(marker) and open(marker).read() == item['sha256'] and os.path.getsize(target) == item['bytes']:
            continue
        os.makedirs(os.path.dirname(target), exist_ok=True)
        url = 'https://huggingface.co/%s/resolve/%s/%s?download=true' % (
            repository, revision, urllib.parse.quote(item['path']))
        _download(url, target, item['bytes'], item['sha256'], ranges=item['bytes'] >= 512 << 20)
        with open(marker, 'w') as out:
            out.write(item['sha256'])
        _say('K_FILE_OK', item['path'], item['bytes'])
    _say('K_FETCHED', directory)


def _download(url, target, size, sha256, ranges=False):
    part = target + '.part'
    with open(part, 'w+b') as out:
        if not ranges:
            with urllib.request.urlopen(url, timeout=120) as response:
                shutil.copyfileobj(response, out, 8 << 20)
        else:
            for start in range(0, size, 512 << 20):
                end = min(start + (512 << 20), size) - 1
                for attempt in range(4):
                    try:
                        request = urllib.request.Request(url, headers={
                            'Range': 'bytes=%d-%d' % (start, end), 'Accept-Encoding': 'identity'})
                        with urllib.request.urlopen(request, timeout=45) as response:
                            if response.status != 206 or response.headers.get('Content-Range') != 'bytes %d-%d/%d' % (start, end, size):
                                raise OSError('range response did not match request')
                            remain = end - start + 1
                            while remain:
                                chunk = response.read(min(8 << 20, remain))
                                if not chunk:
                                    raise OSError('range ended early')
                                out.write(chunk)
                                remain -= len(chunk)
                        break
                    except (OSError, http.client.HTTPException):
                        out.seek(start)
                        out.truncate()
                        if attempt == 3:
                            raise RuntimeError('K_FETCH_RANGE_FAILED') from None
                        time.sleep(2 ** attempt)
        written = out.tell()
        out.seek(0)
        if written != size or hashlib.file_digest(out, 'sha256').hexdigest() != sha256:
            raise RuntimeError('K_VERIFY_FAILED')
    os.replace(part, target)


ENGINE_RELEASE = 'b12532'
ENGINE_ASSETS = (
    ('cudart-llama-b12532-bin-ubuntu-cuda-12.8-x64.tar.gz', 594371476,
     '51e7fc3afa0aee2a1ff15b5b2e3ca0109d9b5e98ff701c326b8bbc9d3df1cde1'),
    ('llama-b12532-bin-ubuntu-cuda-12.8-x64.tar.gz', 223125534,
     'b8054decd73c7b62ee0b96dd932bd98c558e3fa2244cd17ce73d8c2d18e00c8b'),
)


def _install_cuda(binary):
    binaries, lib_dirs = [], set()
    for name, size, digest in ENGINE_ASSETS:
        folder = os.path.join(K, 'run', 'release-' + name.split('-')[0])
        os.makedirs(folder, exist_ok=True)
        archive = os.path.join(folder, 'asset.tar.gz')
        _download('https://github.com/ggml-org/llama.cpp/releases/download/' + ENGINE_RELEASE + '/' + name,
                  archive, size, digest)
        with tarfile.open(archive) as bundle:
            bundle.extractall(folder, filter='data')
        for root, _, files in os.walk(folder):
            if 'llama-server' in files:
                binaries.append(os.path.join(root, 'llama-server'))
            if any('.so' in item for item in files):
                lib_dirs.add(root)
    if len(binaries) != 1:
        raise RuntimeError('K_ENGINE_BINARY_MISSING')
    with open(binary, 'w') as out:
        out.write('#!/bin/sh\nexport LD_LIBRARY_PATH=' + shlex.quote(':'.join(sorted(lib_dirs))) +
                  '${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\nexec ' + shlex.quote(binaries[0]) + ' "$@"\n')
    os.chmod(binary, 0o755)
    result = subprocess.run([binary, '--list-devices'], capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError('K_ENGINE_BINARY_FAILED')
    if not re.search(r'^\s*CUDA\d+:', result.stdout + result.stderr, re.MULTILINE):
        raise RuntimeError('K_ENGINE_NO_CUDA')


def k_engine(commit, prebuilt=False):
    binary = os.path.join(K, 'run', 'llama-server')
    stamp = os.path.join(K, 'run', 'llama.commit')
    src = os.path.join(K, 'src', 'llama.cpp')
    version = ENGINE_RELEASE if prebuilt else commit
    if os.path.exists(binary) and os.path.exists(stamp) and open(stamp).read() == version:
        _say('K_ENGINE', version)
        return
    if prebuilt:
        _install_cuda(binary)
        with open(stamp, 'w') as out:
            out.write(version)
        _say('K_ENGINE', version)
        return
    if not os.path.isdir(os.path.join(src, '.git')):
        _run(['git', 'clone', '--filter=blob:none', 'https://github.com/ggml-org/llama.cpp', src])
    _run(['git', '-C', src, 'fetch', '--depth', '1', 'origin', commit])
    _run(['git', '-C', src, 'checkout', '--detach', commit])
    head = subprocess.run(['git', '-C', src, 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
    if head != commit:
        raise RuntimeError('K_ENGINE_COMMIT_MISMATCH')
    _run(['cmake', '-S', src, '-B', os.path.join(src, 'build'), '-DGGML_CUDA=ON', '-DLLAMA_CURL=OFF',
          '-DLLAMA_USE_PREBUILT_UI=OFF', '-DLLAMA_BUILD_UI=OFF', '-DBUILD_SHARED_LIBS=OFF'])
    _run(['cmake', '--build', os.path.join(src, 'build'), '--config', 'Release', '-j', str(min(4, os.cpu_count() or 4)),
          '--target', 'llama-server'])
    shutil.copy2(os.path.join(src, 'build', 'bin', 'llama-server'), binary)
    with open(stamp, 'w') as out:
        out.write(commit)
    _say('K_ENGINE', commit)


def k_convert(directory, outtype):
    # safetensors -> GGUF at the published precision (bf16/f16 only).
    out = os.path.join(K, 'models', directory + '.%s.gguf' % outtype)
    if os.path.exists(out + '.k-done'):
        _say('K_CONVERTED', out)
        return
    src = os.path.join(K, 'src', 'llama.cpp')
    _run(['python3', '-m', 'pip', 'install', '--no-deps', os.path.join(src, 'gguf-py')])
    _run(['python3', os.path.join(src, 'convert_hf_to_gguf.py'), os.path.join(K, 'models', directory),
          '--outtype', outtype, '--outfile', out])
    open(out + '.k-done', 'w').close()
    _say('K_CONVERTED', out)


def _healthy():
    try:
        with urllib.request.urlopen('http://127.0.0.1:%d/health' % PORT, timeout=5) as response:
            return response.status == 200
    except Exception:
        return False


def k_start(model_path, alias, context, kv_cache_q8=False):
    info = os.path.join(K, 'run', 'server.json')
    wanted = {'model': model_path, 'alias': alias, 'context': context}
    kv_options = []
    if kv_cache_q8:
        wanted['kv_cache'] = 'q8_0'
        kv_options = ['-fa', 'on', '-ctk', 'q8_0', '-ctv', 'q8_0']
    if os.path.exists(info) and json.load(open(info)) == wanted and _healthy():
        _say('K_READY', alias)
        return
    log = open(os.path.join(K, 'run', 'server.log'), 'ab')
    process = subprocess.Popen([os.path.join(K, 'run', 'llama-server'), '-m', model_path, '--alias', alias,
                                '--host', '127.0.0.1', '--port', str(PORT), '-c', str(context), '-ngl', '999', '--jinja', *kv_options],
                               stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    json.dump(wanted, open(info, 'w'))
    waited = 0
    while not _healthy():
        if process.poll() is not None:
            raise RuntimeError('K_SERVER_EXITED %s' % process.returncode)
        time.sleep(5)
        waited += 5
        if waited % 30 == 0:
            _say('K_LOADING', waited)
    _say('K_READY', alias)


def k_health():
    _say('K_HEALTH', 'ok' if _healthy() else 'down')


def _beat(stop, label):
    # Keep the execute_code stream (progress notifications) from going silent while
    # the model works; the local fetch would otherwise end the call as unknown.
    waited = 0
    while not stop.wait(30):
        waited += 30
        _say(label, waited)


def k_relay(request_id):
    # One inference per request id, ever: the started marker is created atomically.
    request = os.path.join(K, 'req', request_id + '.json')
    result = os.path.join(K, 'res', request_id + '.json')
    try:
        os.close(os.open(os.path.join(K, 'res', request_id + '.started'), os.O_CREAT | os.O_EXCL | os.O_WRONLY))
    except FileExistsError:
        _say('K_DONE' if os.path.exists(result) else 'K_UNSETTLED')
        return
    body = json.load(open(request, encoding='utf-8'))
    body['stream'] = False
    call = urllib.request.Request('http://127.0.0.1:%d/v1/responses' % PORT, data=json.dumps(body).encode('utf-8'),
                                  headers={'content-type': 'application/json'}, method='POST')
    stop = threading.Event()
    threading.Thread(target=_beat, args=(stop, 'K_WAITING'), daemon=True).start()
    try:
        with urllib.request.urlopen(call, timeout=None) as response:
            status, text = response.status, response.read().decode('utf-8')
    except urllib.error.HTTPError as error:
        status, text = error.code, error.read().decode('utf-8', 'replace')
    finally:
        stop.set()
    with open(result + '.part', 'w', encoding='utf-8') as out:
        json.dump({'status': status, 'body': text}, out)
    os.replace(result + '.part', result)
    _say('K_DONE')
