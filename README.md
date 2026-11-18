# GPU Observatory · GPU 实时监控

在自己的电脑打开监控面板，连接一台或多台 Linux NVIDIA GPU 服务器。页面默认每 2 秒刷新，可查看 GPU 利用率、显存、温度、功耗、占用进程和用户，以及节点的 CPU 和内存。支持搜索筛选、进程详情和资源告警。

每位使用者在本机运行 `viewer.py`。服务器管理员在 GPU 服务器运行 `server.py`，向使用者提供监控接口地址和访问令牌。同一个接口可以供多人查看。

## 在本机打开页面

克隆本仓库，或下载并解压源码。在项目目录用 Python 3 运行以下命令。Windows、macOS 和 Linux 都可以运行查看端，查看端无需安装额外依赖。

```bash
python viewer.py
```

如果系统的命令是 `python3`，改用 `python3 viewer.py`。浏览器打开 [http://127.0.0.1:8765](http://127.0.0.1:8765)。如果端口已占用，可以运行 `python viewer.py --port 8767`，再打开对应地址。

页面初始展示演示数据。点击右上角「连接服务器」，选择「实时模式」，填写管理员提供的 **监控接口地址**（例如 `https://gpu.example.com/api/metrics`）和 **访问令牌**，然后点击「保存并连接」。令牌仅保留在当前页面内存中，刷新页面后需要重新填写。SSH 登录由自己的 SSH 客户端完成。

查看端从本机向监控接口发请求。服务器需要能从本机通过内网、VPN、HTTPS 或 SSH 隧道访问。使用本地查看端时，无需在采集器配置浏览器跨域访问。想先看看布局，也可以直接打开 `dist/index.html` 体验演示模式。

## 部署 GPU 采集器

在 GPU 服务器放置本仓库源码，并用通常登录服务器的账号启动。先运行 `nvidia-smi`，确认它能看到需要监控的 GPU。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server.py --host 127.0.0.1 --port 8765 --name A800-1
```

采集器默认每 2 秒缓存一次采样，多个查看者读取同一份缓存。可用 `--interval 5` 修改采样间隔。使用 `curl http://127.0.0.1:8765/health` 检查服务是否已启动。采集器持续运行期间才能查看实时数据。

### 用已有的 SSH 账号连接

如果采集器按上面的命令绑定回环地址，查看者在自己电脑另开一个终端，运行并保持隧道在线。将 `user@gpu-server` 替换成实际的登录地址，也可以直接使用 SSH 配置别名。

```bash
ssh -N -L 127.0.0.1:18765:127.0.0.1:8765 user@gpu-server
```

页面依然打开本机查看端的 `http://127.0.0.1:8765`。在「连接服务器」中填写 `http://127.0.0.1:18765/api/metrics`。如果采集器设置了 `MONITOR_TOKEN`，同时填入该令牌。

### 让团队通过同一个监控地址连接

如果查看者无需登录 GPU 服务器，可以用团队现有的 HTTPS 入口，将 `/api/metrics` 反向代理到回环采集器。由管理员设置 `MONITOR_TOKEN`，代理保留 `Authorization` 请求头，再把 HTTPS 接口地址和令牌发给有权查看的人。内网或 VPN 试用时，可以为监听地址指定服务器内网 IP，用防火墙限制可访问来源，且绑定非回环地址时必须设置 `MONITOR_TOKEN`。

```bash
export MONITOR_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
.venv/bin/python server.py --host 127.0.0.1 --port 8765 --name A800-1
```

回环采集器默认仅接受 `Host` 为 `127.0.0.1`、`localhost` 或 `::1` 的 API 请求。如果反向代理保留了外部域名作为上游 `Host`，可配置 `MONITOR_ALLOWED_HOSTS=gpu.example.com`，也可由代理将上游 `Host` 设为 `127.0.0.1:8765`。`MONITOR_ALLOWED_HOSTS` 接受逗号分隔的精确主机名。

采集器也能直接托管网页。如果单独托管静态前端，让浏览器跨域直连接口，则应将 `MONITOR_ALLOWED_ORIGIN` 设为前端的完整来源，例如 `https://dashboard.example.com`。

## 多节点

每台服务器各自运行一个采集器。通过内网、HTTPS 或各自的 SSH 隧道把采集器汇总到一台聚合器。在聚合器上保存私有配置文件，例如 `/private/upstreams.json`。

```json
[
  {"id": "a800-1", "name": "A800-1", "url": "http://127.0.0.1:18765/api/metrics"},
  {"id": "a800-2", "name": "A800-2", "url": "https://collector2.example.com/api/metrics", "token": "replace-with-collector-token"}
]
```

```bash
chmod 600 /private/upstreams.json
.venv/bin/python server.py --no-local --upstreams /private/upstreams.json --port 8765
```

将配置文件放在 Git 仓库之外。各使用者只需连接聚合器。省略 `--no-local` 可以同时采集聚合器所在机器。远端连接失败时，页面会标记节点离线并显示最后观测值。

## 指标范围与验证

`nvidia-smi` 提供 NVIDIA 物理 GPU 和计算进程数据，`psutil` 补充 CPU、系统内存、用户和进程运行时间。采集 API 只读。进程可见性受服务器权限和容器 PID 命名空间约束。图形进程、MIG 实例细分和历史数据持久化未包含在当前版本。

在项目目录运行回归测试。

```bash
python -m pip install -r requirements.txt
python -m unittest discover -s tests -v
node tests/test_frontend.cjs
```

Python 测试需要本机回环网络，前端状态测试需要 Node.js，正常使用查看端无需 Node.js。
