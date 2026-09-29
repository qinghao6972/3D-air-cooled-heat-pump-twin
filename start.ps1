# =============================================================
#  风冷热泵控制系统 · 数字孪生 —— 本地服务器启动器
#  由 启动.bat 调用（-ExecutionPolicy Bypass -File）
#  本文件必须保存为「UTF-8 带 BOM」，否则 Windows PowerShell 5.1
#  会按 GBK 解码，中文提示全变乱码。
# =============================================================

$ErrorActionPreference = 'Stop'
$Port = 8080
$root = $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent $MyInvocation.MyCommand.Definition }
Set-Location -LiteralPath $root

function Line { Write-Host ('  ' + ('=' * 60)) -ForegroundColor DarkCyan }
function Say([string]$t, [string]$c = 'Gray') { Write-Host ('  ' + $t) -ForegroundColor $c }

Write-Host ''
Line
Say '风冷热泵控制系统 · 数字孪生   Digital Twin' 'White'
Line
Write-Host ''

# -------------------------------------------------------------
#  1. 查找可用的 Python 3
#     注意：Windows 自带的 WindowsApps\python.exe 只是微软商店的
#     占位程序，执行它会弹出应用商店而不是真的跑 Python，必须排除。
# -------------------------------------------------------------
$py = $null
$pyVer = ''
foreach ($c in @('python', 'py', 'python3')) {
    $g = Get-Command $c -ErrorAction SilentlyContinue
    if (-not $g) { continue }
    if ($g.Source -like '*\WindowsApps\*') { continue }
    try { $v = (& $g.Source --version 2>&1 | Out-String).Trim() } catch { continue }
    if ($v -match 'Python 3') { $py = $g.Source; $pyVer = $v; break }
}

if (-not $py) {
    Say '[错误] 未找到可用的 Python 3。' 'Red'
    Write-Host ''
    Say '本项目必须通过 HTTP 打开：ES 模块和本地 .glb 模型都不能用'
    Say 'file:// 协议直接双击运行，浏览器会同源策略拦截。'
    Write-Host ''
    Say '解决办法（任选其一）：'
    Say '  1) 安装 Python 3（python.org 下载，安装时勾选 Add to PATH）'
    Say '  2) 用 Node：  npx serve .'
    Say '  3) 用 VS Code 的 Live Server 插件打开本目录'
    Write-Host ''
    Read-Host '  按回车键退出'
    exit 1
}
Say "已找到 Python: $pyVer" 'DarkGray'
Write-Host ''

# -------------------------------------------------------------
#  2. 先启动服务器，再开浏览器
#     Python 绑定端口大约需要 0.6 秒。如果先开浏览器，已经在运行的
#     Edge 会在一两百毫秒内抢着访问，页面就会显示「127.0.0.1 拒绝连接」。
#
#     另外，如果端口上已经跑着本项目的服务器（用户重复双击），就不要
#     重复启动 —— 否则新的 python 会因端口占用而立刻退出，留下一个
#     闪一下就关的窗口。
# -------------------------------------------------------------
function Test-OurApp {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$Port/index.html"
        return [bool]($r.Content -match 'app\.css')
    } catch { return $false }
}

function Open-App([string]$why) {
    Start-Process "http://127.0.0.1:$Port/"
    Write-Host ''
    Say $why 'Green'
    Write-Host ''
    Line
    Say "访问地址: http://127.0.0.1:$Port/" 'White'
    Write-Host ''
    Say '提示：如果浏览器显示「拒绝连接」，等两秒按 F5 刷新一下即可。' 'DarkGray'
    Line
    Write-Host ''
    Start-Sleep -Seconds 3
    exit 0
}

if (Test-OurApp) {
    Say "端口 $Port 上已经在运行本项目的服务器，直接打开浏览器。" 'Green'
    Open-App '复用已有服务器。'
}

Say "正在启动本地服务器 http://127.0.0.1:$Port/ ..."
$proc = Start-Process -FilePath $py `
    -ArgumentList @('-m', 'http.server', "$Port", '--bind', '127.0.0.1') `
    -WorkingDirectory $root -PassThru -WindowStyle Minimized
# Python 解释器启动 + 绑定端口实测约 0.6 秒。这里等足 1 秒，
# 才能可靠地捕捉到「端口被占用 → python 立刻退出」这种情况。
Start-Sleep -Milliseconds 1000

if ($proc.HasExited) {
    Write-Host ''
    Say "[错误] 服务器进程立刻退出了（退出码 $($proc.ExitCode)）。" 'Red'
    Say "最常见的原因是端口 $Port 已被其他程序占用。" 'Yellow'
    Say '请用记事本打开本文件，把顶部的 $Port 改成 8081 后重试。'
    Write-Host ''
    Read-Host '  按回车键退出'
    exit 1
}

# -------------------------------------------------------------
#  3. 轮询端口，并且校验返回内容确实是本项目的页面
#     只看「端口有人监听」不够 —— 万一是别的程序占着，开出来的
#     就不是我们的数字孪生。这里用 index.html 里引用的 app.css 做指纹。
# -------------------------------------------------------------
$ok = $false
$elapsed = 0
for ($i = 1; $i -le 30; $i++) {
    Start-Sleep -Milliseconds 400
    $elapsed = [int]($i * 400)
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://127.0.0.1:$Port/index.html"
        if ($r.Content -match 'app\.css') { $ok = $true; break }
    } catch { }
}

if (-not $ok) {
    Write-Host ''
    Say "[错误] $($elapsed / 1000) 秒内没能连上 http://127.0.0.1:$Port/ 。" 'Red'
    Write-Host ''
    Say '排查方向：' 'Yellow'
    Say "  1) 端口 $Port 被别的程序占用 —— 改本文件顶部的 `$Port 换一个端口"
    Say '  2) 防火墙拦截了 Python —— 在弹出的提示框里选「允许访问」'
    Say '  3) Python 本身有问题 —— 在命令行执行下面这行看报错：'
    Say "       $py -m http.server $Port"
    Write-Host ''
    Say '刚才启动的服务器窗口如果还开着，可以直接关掉。' 'DarkGray'
    Write-Host ''
    Read-Host '  按回车键退出'
    exit 1
}

# -------------------------------------------------------------
#  4. 就绪，打开浏览器
# -------------------------------------------------------------
Start-Process "http://127.0.0.1:$Port/"
Write-Host ''
Say "服务器已就绪（等待 $($elapsed / 1000.0) 秒），浏览器正在打开 ..." 'Green'
Write-Host ''
Line
Say "访问地址: http://127.0.0.1:$Port/" 'White'
Write-Host ''
Say '服务器运行在另一个最小化的窗口里（标题以 python 开头），'
Say '关闭那个窗口即可停止服务。'
Write-Host ''
Say '提示：如果浏览器显示「拒绝连接」，等两秒按 F5 刷新一下即可。' 'DarkGray'
Line
Write-Host ''
Start-Sleep -Seconds 4
exit 0
