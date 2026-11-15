# AI 味体检 · 运维手册

> 最后更新：2026-10-27
> 本文记录线上环境的全部配置、定时任务、故障处理方式，以及踩过的坑。

---

## 一、线上环境

| 项 | 值 |
|---|---|
| 公测地址 | https://qsclh.cn/ |
| 后台地址 | https://qsclh.cn/admin.html |
| 服务器 | 阿里云轻量应用服务器 · 新加坡 |
| 公网 IP | 47.79.236.178 |
| 规格 | 2 核 / 1674 MB / 30 GB ESSD |
| 系统 | Alibaba Cloud Linux 4 |
| swap | 2 GB（`/swapfile`，防 OOM） |
| 项目目录 | `/opt/aitell` |
| Node | v24.18.0 |
| nginx | 1.30.4 |

### 进程结构

```
公网 :443  ──► nginx ──► 127.0.0.1:8787 (Node)
公网 :80   ──► nginx ──► 301 跳 https（ACME 验证直接读 /var/www/acme）
公网 :22   ──► sshd（仅密钥登录，密码登录已关）
```

Node 只绑 `127.0.0.1`，外网必须经过 nginx。

### 身份三级

| 身份 | 入口 | 能看到什么 |
|---|---|---|
| 公测 | 直接打开首页 | 结论横幅 + 环形图 + 百分比。特征、段落、证据、改写建议全部服务端不返回 |
| 内部 | 输入内部 Key 登录 | 全部证据 + 复核按钮 + 训练页签 |
| API | `X-API-Key` 头 | 按 Key 的 role 决定返回内容 |

**内部 Key 不再出现在 URL 里**：登录一次换 `HttpOnly; Secure; SameSite=Lax` Cookie，30 天有效。老链接 `?key=` 仍可用，前端会用它换 Cookie 后立刻从地址栏抹掉。

---

## 二、定时任务

```bash
cat /etc/cron.d/*
```

| 时间 | 任务 | 说明 |
|---|---|---|
| 每天 3:30 | `backup-aitell.sh` | 打包到 `/root/backups/`，保留 7 天 |
| 每天 4:10 | `prune-logs.sh` | 清理 30 天前的 `testlogs.jsonl` 条目 |
| 每 2 分钟 | `ssh-guard.sh` | SSH 限速 + 自动封禁 + 到期解封 |
| 每 5 分钟 | `health-check.sh` | 健康检查，有问题发邮件告警 |

本地（Windows）：定时任务 `AI-Taste-Check-Backup-Pull` 每天 10:00 调用
`QSCBakup.exe --sync` 增量同步到 `E:\qsc\玄武AI检测\_backups\`，错过会自动补跑。

### 桌面客户端（单文件 exe）

`
C:\aitell\QSCBakup.exe              11.5 MB，双击运行
C:\aitell\backup_ui.json            配置（服务器地址 / Key / 本地目录）
桌面快捷方式「QSCBakup」             指向上面的 exe
`

**为什么放在 C:\aitell\ 而不是项目目录**：
PyInstaller 的 onefile 模式启动时要解压到临时目录，**exe 所在目录名含中文就会失败**，
报 `Could not create temporary directory!` 直接退出。实测：

| exe 位置 | 结果 |
|---|---|
| `C:\aitell\QSCBakup.exe`（英文目录 + 中文文件名） | ✅ |
| `C:\Temp\x\backup.exe`（全英文） | ✅ |
| `E:\qsc\玄武AI检测\backup.exe`（中文目录 + 英文文件名） | ❌ |

**卡的是目录名，不是文件名。** `--runtime-tmpdir` 参数救不了这个。

数据目录仍指向 `E:\qsc\玄武AI检测\_backups`（中文路径对 Python 没影响，只影响引导程序）。

### 无界面模式

`
QSCBakup.exe --sync     供定时任务调用，不弹窗，写 sync.log
`

定时任务 `AI-Taste-Check-Backup-Pull` 每天 10:00 调用它。

---

## 三、备份与恢复

### 备份内容

```
/root/backups/aitell-YYYYMMDD-HHMM.tar.gz   约 490 KB，14 项
  server.js  index.html  admin.html  assets/
  model.json  calibration.json
  keys.json  samples.jsonl  corrections.jsonl  testlogs.jsonl  usage.json
  train.py  calibrate.js  openapi.json  README.md
/root/backups/nginx-aitell.conf
/root/backups/aitell.service
```

### 换服务器恢复

```bash
mkdir -p /opt/aitell
tar -xzf aitell-YYYYMMDD-HHMM.tar.gz -C /opt/aitell
cp nginx-aitell.conf /etc/nginx/conf.d/aitell.conf
cp aitell.service /etc/systemd/system/
dnf install -y nginx
systemctl daemon-reload && systemctl enable --now aitell nginx
# 证书
curl -sL https://get.acme.sh -o /tmp/a.sh && bash /tmp/a.sh email=admin@qsclh.cn
mkdir -p /var/www/acme
~/.acme.sh/acme.sh --issue -d qsclh.cn -d www.qsclh.cn -w /var/www/acme --keylength ec-256
```

---

## 四、HTTPS 证书

```
签发：Let's Encrypt（ECC P-256）
路径：/etc/nginx/ssl/qsclh.crt  /etc/nginx/ssl/qsclh.key
管理：acme.sh（~/.acme.sh/）
续期：acme.sh 自带 cron，到期前自动续并 reload nginx
到期：2027-01-25
```

手动续期验证：

```bash
~/.acme.sh/acme.sh --renew -d qsclh.cn --ecc --force
```

---

## 五、告警

配置在 `/etc/aitell-alert.conf`（权限 600）。

```bash
ALERT_TYPE=email
MAIL_SMTP=smtps://smtp.qq.com:465
MAIL_USER=932358349@qq.com
MAIL_PASS=<QQ邮箱授权码>
MAIL_TO=932358349@qq.com
```

### 支持的渠道

`email` / `serverchan` / `wecom` / `dingtalk` / `telegram` / `ntfy` / `webhook`

### 触发条件

| 检查 | 阈值 |
|---|---|
| 应用无响应 | health 接口 5 秒内调不通 |
| nginx 未运行 | `systemctl is-active nginx` 失败 |
| 磁盘占用 | ≥ 85% |
| 证书剩余 | < 14 天 |
| 备份过期 | 最近备份 > 48 小时 |

同一类问题 **30 分钟冷却**，避免刷屏。状态写入 `/var/lib/aitell-health/status.json`，后台页面顶部「系统健康」实时展示。

---

## 六、安全配置

### SSH

```
密码登录：已关闭（PasswordAuthentication no）
root 登录：仅密钥
密钥：本机 C:\Users\Administrator\.ssh\aitell2（无密码短语）
速率限制：每 IP 每 60 秒最多 20 个新连接
自动封禁：10 分钟内失败 ≥5 次 → 封 1 小时
白名单：/var/lib/ssh-guard/allow.txt
```

改白名单后需重跑 `ssh-guard.sh`。

### 静态文件白名单

```js
// server.js
const STATIC_ALLOW = [
  /^\/index\.html$/,
  /^\/admin\.html$/,
  /^\/assets\/[\w.-]+\.(css|js|png|svg|ico|woff2?|ttf)$/
];
```

**新增对外文件必须加进白名单**，否则返回 404。这是有意的：`model.json`（模型权重）和 `server.js`（源码）曾能被直接下载。

### 对外开放端口

只有 `22`、`80`、`443`。`5355`（LLMNR）已关闭。

---

## 七、踩过的坑

### 1. SSH 密钥带了个 `""` 密码

生成时写了 `-N '""'`，PowerShell 把两个字面引号当成了密码。表现是服务器日志显示：

```
Accepted key ED25519 ... found at /root/.ssh/authorized_keys:1
Postponed publickey for root ...
Connection reset by authenticating user root ...   ← 客户端解不开私钥，自己断了
```

指纹匹配、文件权限、SELinux 全都正常，所以排查方向全错。

**正确写法**：`ssh-keygen -t ed25519 -N ''`（空字符串），然后验证：

```powershell
ssh-keygen -y -f 私钥   # 不提示密码就说明没加密
```

### 2. SSH 连不上时先看 `sshd -d`

```bash
/usr/sbin/sshd -d -p 2222
```

前台跑起来后连它，日志直接打印在屏幕上，比翻 `/var/log/secure` 快得多。

### 3. DNS 有两条 A 记录，一条指向死服务器

`qsclh.cn` 同时解析到 `47.79.236.178`（活）和 `8.137.170.132`（已停用），轮询导致一半访客超时。

**删记录前先截图确认**，我删反过一次，把活的删了、死的留着。

验证：

```powershell
Resolve-DnsName qsclh.cn -Type A -Server 8.8.8.8
```

只应返回一个 IP。

### 4. 自己的限速规则把自己的部署挡了

`ssh-guard` 最初设 60 秒最多 5 个连接，而一次部署要开 2-3 个 SSH/SCP，反复把自己锁死。

**改法**：放宽到 20，并把固定出口 IP 加进 `allow.txt`。

### 5. QQ 邮箱只认 `AUTH LOGIN`

curl 默认用 `AUTH PLAIN`，QQ 返回 `334` 然后 `curl: (67) Login denied`。

**正确写法**：

```bash
curl -s --ssl-reqd --login-options AUTH=LOGIN \
  --url smtps://smtp.qq.com:465 \
  --user "邮箱:授权码" \
  --mail-from 邮箱 --mail-rcpt 收件人 --upload-file 邮件文件
```

### 6. `.ps1` 中文无 BOM → PowerShell 5.1 解析失败

UTF-8 无 BOM 的脚本含中文，PS 5.1 按 ANSI 读，乱码导致 `Missing closing '}'`。

**改法**：写文件时加 UTF-8 BOM。

```powershell
[IO.File]::WriteAllText($path, $content, (New-Object Text.UTF8Encoding($true)))
```

### 7. nginx 的 `root` 会拼上完整 URI

```nginx
location /.well-known/acme-challenge/ { root /var/www/acme; }
```

实际查找路径是 `/var/www/acme/.well-known/acme-challenge/xxx`，不是 `/var/www/acme/xxx`。ACME 验证失败多半是这个原因。

---

## 八、常用操作

```bash
# 看服务状态
systemctl status aitell nginx

# 看应用日志
journalctl -u aitell -n 50 --no-pager

# 重启应用（改完 server.js 后）
cd /opt/aitell && node --check server.js && systemctl restart aitell

# 部署前端（改完 assets/app.js 后要递增版本号）
# index.html 里把 ?v=xxx 改掉，否则浏览器用缓存
scp assets/app.js root@47.79.236.178:/opt/aitell/assets/

# 手动跑一次备份 / 健康检查
/usr/local/bin/backup-aitell.sh
/usr/local/bin/health-check.sh

# 看健康状态
cat /var/lib/aitell-health/status.json

# 看 SSH 守卫
tail -20 /var/log/ssh-guard.log
cat /var/lib/ssh-guard/allow.txt
```

---

## 九、重建桌面客户端

`powershell
cd E:\qsc\玄武AI检测\_deploy
C:\Python314\python.exe -m PyInstaller --noconfirm --clean --onefile --windowed `
  --name aitell-backup --distpath .\dist-one --workpath .\build4 --specpath . backup_ui.py

# 打完把 exe 复制到英文目录（目录名不能含中文，否则启动失败）
Copy-Item .\dist-one\aitell-backup.exe C:\aitell\QSCBakup.exe -Force
`

环境：Python 3.14.6 + PyInstaller 6.21.0，产物 11.5 MB，启动约 2 秒（onefile 要解压）。