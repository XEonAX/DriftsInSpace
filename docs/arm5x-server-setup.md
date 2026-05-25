# arm5x Server Setup Guide

**Instance:** arm5x  
**IP:** ORIGIN_IP  
**Hostname:** galacticdrifters.aeonax.com (Cloudflare proxied)  
**OS:** Ubuntu 24.04 Minimal aarch64  
**Shape:** VM.Standard.A1.Flex (1 OCPU · 2 GB RAM · 1 Gbps)  
**SSH key:** `/Users/user/Sync/arm5x.key`

> SSH must use the direct IP — the hostname resolves to Cloudflare's edge and port 22 never reaches the origin.

---

## 1. First Connection

**Mac:**
```bash
chmod 600 /Users/user/Sync/arm5x.key
ssh -i /Users/user/Sync/arm5x.key ubuntu@ORIGIN_IP
```

---

## 2. Initial System Update

**Server:**
```bash
sudo apt update && sudo apt full-upgrade -y
sudo apt autoremove -y
```

---

## 3. Harden SSH

### 3a. Verify your public key is present

**Server:**
```bash
cat ~/.ssh/authorized_keys   # should show contents of arm5x.key.pub
```

If it is missing:

**Mac:**
```bash
ssh-copy-id -i /Users/user/Sync/arm5x.key.pub -o IdentityFile=/Users/user/Sync/arm5x.key ubuntu@ORIGIN_IP
```

### 3b. Harden sshd_config

**Server:**
```bash
sudo sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?X11Forwarding.*/X11Forwarding no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?AllowTcpForwarding.*/AllowTcpForwarding no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?MaxAuthTries.*/MaxAuthTries 3/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?LoginGraceTime.*/LoginGraceTime 30/' /etc/ssh/sshd_config
```

Verify the changes:

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
AuthorizedKeysFile .ssh/authorized_keys
X11Forwarding no
AllowTcpForwarding no
MaxAuthTries 3
LoginGraceTime 30
```

**Server:**
```bash
sudo grep -E "PermitRootLogin|PasswordAuthentication|X11Forwarding|AllowTcpForwarding|MaxAuthTries|LoginGraceTime" /etc/ssh/sshd_config
```

**Server:**
```bash
sudo systemctl reload ssh
```

> **Keep your current terminal open** and test login in a second terminal before closing.

---

## 4. Configure the Firewall (iptables)

> **Note:** OCI Ubuntu 24.04 Minimal uses `iptables` directly. `iptables-persistent` conflicts with UFW and will remove it — do not install UFW.

The OCI image ships with iptables rules that already allow port 22 and reject everything else. Install `iptables-persistent` to make rules survive reboots, then add port 443:

**Server:**
```bash
sudo apt install -y iptables-persistent
# Answer "yes" to both "Save current IPv4/IPv6 rules?" prompts

sudo iptables -I INPUT 5 -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

Verify:
```bash
sudo iptables -L INPUT -n --line-numbers
# Should show ACCEPT tcp dpt:443 before the REJECT rule
```

---

## 5. Open OCI Security List Ports

The OCI Security List (VCN level) must also allow port 443.

1. OCI Console → **Networking → Virtual Cloud Networks → arm5x-vcn**
2. Open the **Security List** for the public subnet
3. Port 22 is pre-added by OCI — no action needed
4. Add one Ingress Rule for port 443:
   - Source Type: `CIDR` · Source: `0.0.0.0/0` · IP Protocol: `TCP`
   - **Source Port Range:** *(leave blank)*
   - **Destination Port Range:** `443`

---

## 6. Install fail2ban

**Server:**
```bash
sudo apt install -y fail2ban

sudo tee /etc/fail2ban/jail.local <<'EOF'
[sshd]
enabled  = true
port     = ssh
maxretry = 5
bantime  = 3600
findtime = 600
EOF

sudo systemctl enable --now fail2ban
sudo fail2ban-client status sshd
```

---

## 7. Enable Unattended Security Upgrades

**Server:**
```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades
# Accept "Yes" at the prompt
```

---

## 8. Install .NET 8 Runtime

**Server:**
```bash
wget https://packages.microsoft.com/config/ubuntu/24.04/packages-microsoft-prod.deb -O /tmp/packages-microsoft-prod.deb
sudo dpkg -i /tmp/packages-microsoft-prod.deb
sudo apt update
sudo apt install -y aspnetcore-runtime-8.0
dotnet --list-runtimes
```

---

## 9. Create Service Directory Structure

**Server:**
```bash
mkdir -p /home/ubuntu/DriftsInSpaceServer/Deployment
```

---

## 10. Install & Configure nginx + TLS

### 10a. Install nginx

**Server:**
```bash
sudo apt install -y nginx
sudo systemctl enable nginx
```

### 10b. Cloudflare Origin Certificate

**In Cloudflare dashboard:**
1. ~~DNS → Proxied~~ ✅ done
2. SSL/TLS → set mode to **Full (strict)**
3. SSL/TLS → Origin Server → **Create Certificate** (15-year, RSA 2048)
4. Copy **Origin Certificate** → paste into `/etc/ssl/certs/cf-origin.pem` on the server
5. Copy **Private Key** → paste into `/etc/ssl/private/cf-origin.key` on the server

**Server:**
```bash
# Paste the Origin Certificate (end with Ctrl+D on a new line):
sudo tee /etc/ssl/certs/cf-origin.pem
# Paste the Private Key (end with Ctrl+D on a new line):
sudo tee /etc/ssl/private/cf-origin.key
sudo chmod 644 /etc/ssl/certs/cf-origin.pem
sudo chmod 600 /etc/ssl/private/cf-origin.key
```

### 10c. nginx site config

**Server:**
```bash
sudo tee /etc/nginx/sites-available/driftsinspace <<'NGINX'
server {
    listen 80;
    server_name galacticdrifters.aeonax.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name galacticdrifters.aeonax.com;

    ssl_certificate     /etc/ssl/certs/cf-origin.pem;
    ssl_certificate_key /etc/ssl/private/cf-origin.key;

    location /ws {
        proxy_pass         http://127.0.0.1:1234;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    $http_upgrade;
        proxy_set_header   Connection "Upgrade";
        proxy_set_header   Host       $host;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass       http://127.0.0.1:1234;
        proxy_set_header Host $host;
    }
}
NGINX

sudo ln -s /etc/nginx/sites-available/driftsinspace /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 11. Update appsettings.Production.json

~~Already done in the repo~~ ✅ — Kestrel is configured for plain HTTP on port 1234; nginx handles TLS.

---

## 12. Deploy

Run the VS Code task **`server: rsync up publish (arm5x)`** — publishes and rsyncs in one step.

Verify:

**Server:**
```bash
ls /home/ubuntu/DriftsInSpaceServer/Deployment/
```

---

## 13. Install the systemd Service

**Server:**
```bash
sudo cp /home/ubuntu/DriftsInSpaceServer/Deployment/DriftsInSpaceServer.service \
        /etc/systemd/system/DriftsInSpaceServer.service

sudo systemctl daemon-reload
sudo systemctl enable DriftsInSpaceServer
sudo systemctl start  DriftsInSpaceServer
sudo systemctl status DriftsInSpaceServer
```

Check logs:

**Server:**
```bash
journalctl -u DriftsInSpaceServer -f
```

---

## 14. Adding More Services Later

For each additional service (e.g. ANXRacersGalaxy, ANXStudiosServer):

1. `mkdir -p /home/ubuntu/<ServiceName>/Deployment` on the server
2. Copy its `.service` file to `/etc/systemd/system/`
3. Add a new nginx `server { }` block under `/etc/nginx/sites-available/`
4. Issue a Cloudflare origin cert for its subdomain (or reuse one with a wildcard)
5. Bind the service to `127.0.0.1:<port>` — nginx is the only public entry point

---

## 15. Verify Everything

**Server:**
```bash
sudo systemctl status DriftsInSpaceServer nginx
sudo iptables -L INPUT -n --line-numbers
sudo fail2ban-client status sshd
journalctl -u DriftsInSpaceServer --since "5 minutes ago"
```

**Mac:**
```bash
curl https://galacticdrifters.aeonax.com/
# Expected: DriftsInSpace server OK
```
