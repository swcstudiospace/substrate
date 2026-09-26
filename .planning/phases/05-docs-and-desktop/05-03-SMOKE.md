# 05-03 substrate-desktop evidence

Recorded from observed output only.

Commands (run as root from /root/src/repos/agent-substrate, in this order):

```
docker inspect --format '{{.State.StartedAt}}' recruitment-desktop        # read only
umask 077; sudo tee /var/lib/substrate/phase5-baseline/RESTORE.d/05-03.md   # routes, before up
df --output=avail -B1 / | tail -n 1
sudo infra/desktop/substrate-desktop.sh up
sudo infra/desktop/substrate-desktop.sh status
sudo infra/desktop/substrate-desktop.sh up                                   # re-run: same id?
ss -ltnH '( sport = :6081 )'
docker port substrate-desktop
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:6081/               # no credentials
sudo bash -c 'umask 077; n=/var/lib/substrate/phase5-baseline/.05-03-netrc; . /etc/substrate/substrate-desktop.env; printf "machine 127.0.0.1 login %s password %s\n" "$CUSTOM_USER" "$PASSWORD" > "$n"; curl -s -o /dev/null -w "%{http_code}\n" --netrc-file "$n" http://127.0.0.1:6081/; rm -f "$n"'
sudo stat -c '%a %U' /etc/substrate/substrate-desktop.env
sudo sed -n 's/=.*//p' /etc/substrate/substrate-desktop.env
docker inspect --format '{{.State.StartedAt}}' recruitment-desktop        # read only
```

The netrc was 0600 under /var/lib/substrate/phase5-baseline/, built by a root shell from the env
file with builtins only (the password never reached argv or output) and removed right after
(`netrc-removed` printed).

image_local=true
disk_avail_before_up=175133429760
restore_route_written=true
env_file_mode=600 root
env_file_keys=CUSTOM_USER,PASSWORD
container_id=1917e37f4d54d632ab7f62d3ab5a1558e4740b666946966aca4064f904fe7ba7
exists=true
running=true
restart=unless-stopped
ports=127.0.0.1:6081->3000
geometry=1280x800
image=linuxserver/webtop:ubuntu-xfce
label_role=desktop
privileged=false
mounts=volume:substrate-desktop-config->/config
docker_socket_mounted=false
listener_6081=127.0.0.1:6081
webview_noauth_http=401
webview_auth_http=200
up_rerun_same_id=true
recruitment_started_at_before=2026-09-26T15:03:13.690881811Z
recruitment_started_at_after=2026-09-26T15:03:13.690881811Z
recruitment_unchanged=true

Raw output:

    $ docker image inspect linuxserver/webtop:ubuntu-xfce --format '{{.Id}}'
    sha256:c4ceafc1c48ed9a61771345c74568d3bff6438802f0d89e9ebd9846e8404f696
    $ sudo stat -c '%a %U' /var/lib/substrate/phase5-baseline/RESTORE.d/05-03.md   # written before up
    600 root
    $ sudo infra/desktop/substrate-desktop.sh up          # first run (see note below)
    $ sudo infra/desktop/substrate-desktop.sh status
    exists=true
    running=true
    restart=unless-stopped
    ports=127.0.0.1:6081->3000
    geometry=1280x800
    image=linuxserver/webtop:ubuntu-xfce
    label_role=desktop
    privileged=false
    mounts=volume:substrate-desktop-config->/config
    docker_socket_mounted=false
    id=1917e37f4d54d632ab7f62d3ab5a1558e4740b666946966aca4064f904fe7ba7
    $ sudo infra/desktop/substrate-desktop.sh up          # re-run
    up id=1917e37f4d54d632ab7f62d3ab5a1558e4740b666946966aca4064f904fe7ba7 geometry=1280x800
    rc=0
    $ ss -ltnH '( sport = :6081 )'
    LISTEN 0      4096   127.0.0.1:6081 0.0.0.0:*
    $ docker port substrate-desktop
    3000/tcp -> 127.0.0.1:6081
    webview without credentials: 401
    webview with credentials (netrc): 200
    netrc-removed
    $ sudo stat -c '%a %U' /etc/substrate/substrate-desktop.env
    600 root
    $ sudo sed -n 's/=.*//p' /etc/substrate/substrate-desktop.env | paste -sd, -
    CUSTOM_USER,PASSWORD

Note on the first `up`: the executor's tool harness ended the parent shell of the first
`sudo infra/desktop/substrate-desktop.sh up` at its 30 s cell deadline while the script was in its
geometry wait, so that run's stdout was not captured. The script process kept running and exited
on its own; `docker ps` then showed `1917e37f4d54 Up 32 seconds 3001/tcp, 127.0.0.1:6081->3000/tcp`
and `docker exec -e DISPLAY=:1 substrate-desktop xdotool getdisplaygeometry` printed `1280 800`.
`status` and the re-run `up` above are complete captures.

## Task 3 — desktop_run over MCP (D-13, D-19, D-14 part 2)

Recorded from observed output only. Commands (root, from /root/src/repos/agent-substrate; the
propose key is read from the root-only key file on stdin and never printed):

```
sudo tee -a /var/lib/substrate/phase5-baseline/RESTORE.d/05-03.md          # code route, before each restart
sudo systemctl restart substrate-mcp
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7410/healthz       # polled until 200
systemctl show substrate-mcp -p ActiveEnterTimestamp --value
ss -ltnH '( sport = :7410 )'
curl -s -m 60 -X POST http://127.0.0.1:7410/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data-binary @tools-list.json
curl -s -m 60 -X POST http://127.0.0.1:7410/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data-binary @anon-call.json   # no key header
openssl rand -hex 4                                                          # nonce
sudo sed 's/^/x-substrate-propose-key: /' /var/lib/substrate/skills/propose.key | curl -s -m 150 -X POST http://127.0.0.1:7410/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H @- --data-binary @smoke-call.json
python3 -c '<parse the SSE data: line; print key=value only>' smoke-reply.sse
file -b <png>; stat -c '%a %U' <png>
sudo systemd-run --quiet --wait --pipe --collect -p EnvironmentFile=/etc/substrate/substrate.env -p WorkingDirectory=/root/src/repos/agent-substrate -E HOME=/root bun events-count.ts <run_id>   # throwaway, deleted
docker inspect --format '{{.State.StartedAt}}' recruitment-desktop           # read only
```

Request and reply files are 0600 under /var/lib/substrate/phase5-baseline/05-03/ (smoke-call.json,
smoke-reply.sse, tools-list.sse, anon-call.sse, and the three failed replies). events-count.ts
(GreptimeClient.sql through loadConfig, counts only) was deleted after use.

The smoke's typed text is the plan's plus `unset PROMPT_COMMAND; ` (see Gaps 1):
`PS1='$ '; unset PROMPT_COMMAND; printf '\033]0;substrate-smoke-031fd710\007'`, with actions
key ctrl+alt+t (settle 2500), type, key Return (settle 1000), screenshot; timeout 60.

mcp_restarted_at=2026-09-26T19:31:28Z
healthz_after_restart=200
bind_7410=127.0.0.1
tools_list_has_desktop_run=true
anon_desktop_run_refused=true
smoke_nonce=031fd710
smoke_run_id=dr-20260926T193225Z-903657
smoke_actions_ok=4
smoke_title=Terminal - substrate-smoke-031fd710
smoke_png=1280x800
smoke_png_mode=600
smoke_image_block=true
smoke_events=4
typed_text_in_events=0
recruitment_unchanged_after_smoke=true

Raw output (final restart and run):

    restart_issued=2026-09-26T19:31:29Z
    healthz=200 after 4s
    active
    Sat 2026-09-26 19:31:28 UTC
    LISTEN 0      512    127.0.0.1:7410 0.0.0.0:*
    tools/list: desktop_run present, annotations {"destructiveHint": false, "openWorldHint": true}
    anonymous tools/call desktop_run [{type:"screenshot"}]: isError=true,
      "desktop_run needs an authenticated surface or the host propose key; nothing was run"
      (no /var/lib/substrate/desktop dir existed after the first anonymous call: nothing ran)
    smoke_started=2026-09-26T19:32:21Z  curl_exit=0 ended=2026-09-26T19:33:06Z
    is_error=false  block_types=text,image
    run_id=dr-20260926T193225Z-903657  ok_count=4
    log=[[0, "key", true, 7702, "Terminal - @1917e37f4d54:~", null],
         [1, "type", true, 14202, "Terminal - @1917e37f4d54:~", null],
         [2, "key", true, 6200, "Terminal - substrate-smoke-031fd710", null],
         [3, "screenshot", true, 8097, "Terminal - substrate-smoke-031fd710", null]]
    screenshot_path=/var/lib/substrate/desktop/dr-20260926T193225Z-903657/1.png
    screenshot 1280x800 sha256=92132236c0184436fed91de9a2addbea84a83291cd7a3e22f31022cc75724fba
    image block sha256 (base64-decoded) = 92132236c0184436fed91de9a2addbea84a83291cd7a3e22f31022cc75724fba
    $ file -b <png>
    PNG image data, 1280 x 800, 8-bit/color RGB, non-interlaced
    $ stat -c '%a %U' <png>; <run dir>; /var/lib/substrate/desktop
    600 root
    700 root
    700 root
    events-count.ts dr-20260926T193225Z-903657: smoke_events=4, typed_text_in_events=0
    recruitment-desktop StartedAt 2026-09-26T15:03:13.690881811Z (05-BASELINE value) before each
    restart and after the smoke

## Failed runs

    1. dr-20260926T190558Z-78e9ac (19:05:58Z, first restart 19:04:13Z, 10 s per-action budget):
       [[0,"key",true,11599,null,null],[1,"type",false,10099,null,"timeout"]]; 2 events, 0 carry
       the typed text. Cause: docker exec takes 4-7 s here (vmstat: st 71-76, load 15-23 on 8
       vCPUs) and xdotool types ~160 ms/char, so the 58-char type exceeded 10 s.
    2. dr-20260926T190803Z-aa4a0b (19:08:03Z, same build): identical shape, type "timeout" at
       10000 ms; 2 events, 0 carry the typed text. Fixed by 1780c6e (30 s per call, +200 ms per
       typed character, post-action title read keeps its budget); second restart 19:18:59Z.
    3. dr-20260926T192002Z-a8619b (19:20:02Z, nonce 6142ed08): key/type/key ok (9899, 15598, 7401 ms)
       but screenshot "xwd: 24 bits per pixel, expected 32"; titles stayed
       "Terminal - @1917e37f4d54:~"; 4 events, 0 carry the typed text; no PNG written. The real
       xwd header: version 7, ZPixmap, depth 24, bits_per_pixel 24, bytes_per_line 5120, visual
       class 5 (DirectColor), masks ff0000/ff00/ff, ncolors 256, byte_order 0 — packed 3-byte
       pixels (checked by rendering both readings). Fixed by b0390d8; third restart 19:31:28Z.
       The unchanged title: /etc/profile.d/vte-2.91.sh (sourced by /etc/bash.bashrc) adds
       __vte_precmd to PROMPT_COMMAND, which prints OSC 0 "${USER}@${HOSTNAME%%.*}:${pwd}" at every
       prompt (USER is empty in the session, hence "@1917e37f4d54:~"), overwriting the smoke's
       title right after Return.

## Gaps

1. The GUI smoke's typed text adds `unset PROMPT_COMMAND; ` to the plan's text. Resetting PS1
   alone (research Q3 [INFERENCE]) does not keep the title: the image's vte-2.91.sh prompt hook
   re-sets it. `unset` (not `PROMPT_COMMAND=`) because bash here keeps PROMPT_COMMAND as an array.
   xfce4-terminal 1.1.5 shows the shell title appended to its initial title ("Terminal - …"), so
   smoke_title contains, rather than equals, substrate-smoke-<nonce>.
2. Per-call budgets differ from the plan's flat 10 s: ACTION_TIMEOUT_MS is 30 s, a type action
   adds 200 ms per character (xdotool's --delay alone is 12 ms/char), and the title read after an
   action keeps its full budget past the run deadline (the deadline still stops every action that
   has not started). The run deadline stays 1..120 s.
3. decodeXwd accepts packed 24 bpp as well as 32 bpp (the plan's contract refused 24 bpp; this
   Xvfb's xwd writes it).
4. substrate-mcp was restarted three times (19:04:13Z, 19:18:59Z, 19:31:28Z), each after a commit
   and after its code route was appended to RESTORE.d/05-03.md; mcp_restarted_at is the last.
5. A timed-out call kills only the local `docker exec` client; the process inside the container
   can finish on its own (text from failed runs 1-2, nonce 11a60a49, is visible in a terminal). The desktop keeps the
   failed runs' three extra terminal windows; nothing outside the container was affected.
6. The first Task 1 `up` stdout was not captured (see the note above); status and the re-run are.
