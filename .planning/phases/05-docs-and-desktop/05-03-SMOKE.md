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
