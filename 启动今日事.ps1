#Requires -Version 5.1
<#
    今日事 —— Windows 桌面启动器（主逻辑）

    用法：
        启动今日事.ps1 [-Port 8788] [-NoOpen] [-Restart]
                       [-InstallAutostart] [-RemoveAutostart] [-Help]

    退出码：
        0 = 成功
        1 = 没有找到 Node.js
        2 = 找不到 server.js
        3 = 服务启动失败 / 未在 12 秒内就绪
        4 = 8788-8798 端口段没有可用端口

    说明：本文件含中文，必须保存为「UTF-8 带 BOM」，否则 PowerShell 5.1 会乱码。
#>
[CmdletBinding()]
param(
    [int]$Port = 8788,
    [switch]$NoOpen,
    [switch]$Restart,
    [switch]$InstallAutostart,
    [switch]$RemoveAutostart,
    [Alias('h')]
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# ---------------------------------------------------------------- 常量
$ExitOk       = 0
$ExitNoNode   = 1
$ExitNoServer = 2
$ExitFailed   = 3
$ExitNoPort   = 4

$PortRangeEnd = 8798      # 探测端口范围的上界（含）
$PingTimeout  = 300       # 探测 /api/ping 的超时（毫秒）
$ReadySeconds = 12        # 等待服务就绪的最长秒数
$QuitSeconds  = 8         # -Restart 时等待旧服务释放端口的最长秒数
$LnkName      = '今日事.lnk'
$NodeUrl      = 'https://nodejs.org/zh-cn'

$ScriptDir  = $PSScriptRoot
$ScriptPath = $PSCommandPath
$ServerJs   = Join-Path $ScriptDir 'server.js'
$DataDir    = Join-Path $ScriptDir 'data'
$ServerLog  = Join-Path $DataDir 'server.log'
$ErrLog     = Join-Path $DataDir 'server.err.log'
$IcoPath    = Join-Path $ScriptDir 'app.ico'

# ---------------------------------------------------------------- 输出助手
function Write-Head {
    Write-Host ''
    Write-Host '  ┌──────────────────────────────────────────┐' -ForegroundColor DarkCyan
    Write-Host '  │            今日事 · 桌面启动器           │' -ForegroundColor DarkCyan
    Write-Host '  └──────────────────────────────────────────┘' -ForegroundColor DarkCyan
}

function Write-Step {
    param([string]$Number, [string]$Text)
    Write-Host ''
    Write-Host ("  [" + $Number + "] " + $Text) -ForegroundColor Cyan
}

function Write-Detail {
    param([string]$Text, [ValidateSet('info', 'ok', 'warn', 'err')][string]$Level = 'info')
    $color = 'Gray'
    if ($Level -eq 'ok')   { $color = 'Green' }
    if ($Level -eq 'warn') { $color = 'Yellow' }
    if ($Level -eq 'err')  { $color = 'Red' }
    Write-Host ('        ' + $Text) -ForegroundColor $color
}

function Write-Blank { Write-Host '' }

# ---------------------------------------------------------------- 通用工具
# 读取文本文件（即使被别的进程占用也能读，用于读日志）
function Read-TextFileShared {
    param([string]$Path)
    try {
        $fs = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open,
                                     [System.IO.FileAccess]::Read,
                                     [System.IO.FileShare]::ReadWrite)
        try {
            $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
            return $sr.ReadToEnd()
        } finally {
            if ($sr) { $sr.Close() }
            $fs.Close()
        }
    } catch {
        return $null
    }
}

# 打印日志尾部
function Show-LogTail {
    param([string]$Path, [string]$Label, [int]$Lines = 20)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $text = Read-TextFileShared -Path $Path
    if ($null -eq $text) {
        Write-Detail ('日志文件读不出来（可能被占用）：' + $Path) 'warn'
        return $false
    }
    $text = $text.TrimEnd("`r", "`n")
    if (-not $text) { return $false }
    $all = @($text -split "`r?`n")
    $tail = $all
    if ($all.Count -gt $Lines) { $tail = $all[($all.Count - $Lines)..($all.Count - 1)] }
    Write-Blank
    Write-Host ('  ── ' + $Label + '（最后 ' + $tail.Count + ' 行）' + ('─' * 10)) -ForegroundColor DarkYellow
    foreach ($line in $tail) { Write-Host ('  │ ' + $line) -ForegroundColor DarkGray }
    Write-Host ('  ' + ('─' * 40)) -ForegroundColor DarkYellow
    return $true
}

# ---------------------------------------------------------------- Node.js 定位
function Resolve-NodePath {
    $candidates = New-Object System.Collections.Generic.List[string]

    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) {
        foreach ($p in @($cmd.Source, $cmd.Path, $cmd.Definition)) {
            if ($p -and ([string]$p).Trim()) { [void]$candidates.Add(([string]$p).Trim()) }
        }
    }
    [void]$candidates.Add('C:\Program Files\nodejs\node.exe')
    if ($env:ProgramFiles) { [void]$candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe')) }
    if (${env:ProgramFiles(x86)}) { [void]$candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe')) }

    # 优先取真正的 node.exe（.cmd / .ps1 外壳不能直接给 Start-Process 用）
    foreach ($c in $candidates) {
        if ($c -like '*.exe' -and (Test-Path -LiteralPath $c -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $c).Path
        }
    }
    # 退而求其次：任何存在的可执行外壳
    foreach ($c in $candidates) {
        if (Test-Path -LiteralPath $c -PathType Leaf) { return (Resolve-Path -LiteralPath $c).Path }
    }
    return $null
}

# ---------------------------------------------------------------- HTTP 探测
# GET /api/ping，返回原始响应体；失败返回 $null
function Invoke-PingRaw {
    param([int]$TargetPort, [int]$TimeoutMs = 300)
    $req = $null
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$TargetPort/api/ping")
        $req.Method           = 'GET'
        $req.Timeout          = $TimeoutMs
        $req.ReadWriteTimeout = $TimeoutMs
        $req.Proxy            = $null
        $req.AllowAutoRedirect = $false
        $req.KeepAlive        = $false
        $resp = $req.GetResponse()
        try {
            $sr = New-Object System.IO.StreamReader($resp.GetResponseStream())
            return $sr.ReadToEnd()
        } finally {
            if ($sr) { $sr.Close() }
            $resp.Close()
        }
    } catch {
        if ($req) { try { $req.Abort() } catch { } }
        return $null
    }
}

# 只有 name = today-server 才算「我们的服务」
function Get-TodayServerInfo {
    param([int]$TargetPort, [int]$TimeoutMs = 300)
    $body = Invoke-PingRaw -TargetPort $TargetPort -TimeoutMs $TimeoutMs
    if (-not $body) { return $null }
    try { $o = $body | ConvertFrom-Json } catch { return $null }
    if ($o -and $o.name -eq 'today-server') { return $o }
    return $null
}

# 端口上是否有程序在监听（用于区分「别的程序占用」）
function Test-PortBusy {
    param([int]$TargetPort, [int]$TimeoutMs = 300)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect('127.0.0.1', $TargetPort, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $client.EndConnect($iar)
        return $true
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

# POST /api/quit，让旧服务优雅退出
function Invoke-Quit {
    param([int]$TargetPort, [int]$TimeoutMs = 2000)
    $req = $null
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$TargetPort/api/quit")
        $req.Method        = 'POST'
        $req.ContentLength = 0
        $req.Timeout       = $TimeoutMs
        $req.Proxy         = $null
        $req.KeepAlive     = $false
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch {
        if ($req) { try { $req.Abort() } catch { } }
        return $false
    }
}

# 扫描端口段：找到「已在运行的今日事服务」和「第一个空闲端口」
function Get-PortState {
    param([int]$StartPort, [int]$EndPort)
    $existingPort = 0
    $existingInfo = $null
    $freePort     = 0
    $busyPorts    = New-Object System.Collections.Generic.List[int]
    for ($p = $StartPort; $p -le $EndPort; $p++) {
        $info = Get-TodayServerInfo -TargetPort $p -TimeoutMs $PingTimeout
        if ($info) {
            if ($existingPort -eq 0) { $existingPort = $p; $existingInfo = $info }
            continue
        }
        if (Test-PortBusy -TargetPort $p -TimeoutMs $PingTimeout) {
            [void]$busyPorts.Add($p)      # 被别的程序占用
            continue
        }
        if ($freePort -eq 0) { $freePort = $p }
    }
    return [pscustomobject]@{
        ExistingPort = $existingPort
        ExistingInfo = $existingInfo
        FreePort     = $freePort
        BusyPorts    = $busyPorts.ToArray()
    }
}

# ---------------------------------------------------------------- Edge 定位
function Resolve-EdgePath {
    $list = New-Object System.Collections.Generic.List[string]
    [void]$list.Add('C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')
    [void]$list.Add('C:\Program Files\Microsoft\Edge\Application\msedge.exe')
    if (${env:ProgramFiles(x86)}) { [void]$list.Add((Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')) }
    if ($env:ProgramFiles)       { [void]$list.Add((Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')) }
    [void]$list.Add((Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'))

    foreach ($p in $list) {
        if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) { return $p }
    }
    # 注册表兜底
    try {
        $rk = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe'
        if (Test-Path $rk) {
            $v = (Get-ItemProperty -Path $rk -ErrorAction SilentlyContinue).'(default)'
            if ($v -and (Test-Path -LiteralPath $v -PathType Leaf)) { return $v }
        }
    } catch { }
    return $null
}

# ---------------------------------------------------------------- 帮助
function Show-Usage {
    Write-Head
    Write-Blank
    Write-Host '  用法：' -ForegroundColor White
    Write-Host '    启动今日事.cmd                    启动服务并打开应用窗口'
    Write-Host '    启动今日事.cmd -Port 8790         从 8790 开始找端口'
    Write-Host '    启动今日事.cmd -Restart           先让已运行的服务退出，再重新启动'
    Write-Host '    启动今日事.cmd -NoOpen            只启动后台服务，不开窗口（开机自启用）'
    Write-Host '    开机自启-安装.cmd                 设置开机自动启动'
    Write-Host '    开机自启-取消.cmd                 取消开机自动启动'
    Write-Blank
    Write-Host '  参数：' -ForegroundColor White
    Write-Host '    -Port <整数>        起始端口，默认 8788（会在 8788-8798 之间自动找空闲端口）'
    Write-Host '    -NoOpen             只启动后台服务，不打开应用窗口'
    Write-Host '    -Restart            先调用 /api/quit 让已有服务退出，再重新启动'
    Write-Host '    -InstallAutostart   安装开机自启（在当前用户的启动文件夹放一个快捷方式）'
    Write-Host '    -RemoveAutostart    取消开机自启'
    Write-Host '    -Help               显示本帮助'
    Write-Blank
    Write-Host '  退出码：0 成功 / 1 没装 Node.js / 2 找不到 server.js / 3 启动失败 / 4 没有可用端口' -ForegroundColor DarkGray
    Write-Blank
}

# ---------------------------------------------------------------- 开机自启
function Get-StartupLnkPath {
    return (Join-Path ([Environment]::GetFolderPath('Startup')) $LnkName)
}

function Install-Autostart {
    Write-Step '1/2' '检查运行环境'
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
        Write-Detail ('找不到本脚本自身：' + $ScriptPath) 'err'
        return $ExitFailed
    }
    Write-Detail ('脚本位置：' + $ScriptPath) 'ok'

    Write-Step '2/2' '设置开机自启'
    $startupDir = [Environment]::GetFolderPath('Startup')
    if (-not $startupDir) {
        Write-Detail '取不到当前用户的「启动」文件夹，无法设置开机自启。' 'err'
        return $ExitFailed
    }
    if (-not (Test-Path -LiteralPath $startupDir)) {
        New-Item -ItemType Directory -Path $startupDir -Force | Out-Null
    }

    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $psExe -PathType Leaf)) { $psExe = 'powershell.exe' }

    $lnk = Get-StartupLnkPath
    $shell = $null
    $sc = $null
    try {
        $shell = New-Object -ComObject WScript.Shell
        $sc = $shell.CreateShortcut($lnk)
        $sc.TargetPath       = $psExe
        $sc.Arguments        = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $ScriptPath + '" -NoOpen'
        $sc.WorkingDirectory = $ScriptDir
        if (Test-Path -LiteralPath $IcoPath -PathType Leaf) { $sc.IconLocation = $IcoPath + ',0' }
        $sc.Description      = '今日事 后台服务（开机自动启动）'
        $sc.Save()
    } catch {
        Write-Detail ('创建快捷方式失败：' + $_.Exception.Message) 'err'
        return $ExitFailed
    } finally {
        if ($sc)    { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($sc) } catch { } }
        if ($shell) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($shell) } catch { } }
    }

    if (-not (Test-Path -LiteralPath $lnk -PathType Leaf)) {
        Write-Detail '快捷方式没有创建成功。' 'err'
        return $ExitFailed
    }

    Write-Detail '已设置开机自启' 'ok'
    Write-Detail ('快捷方式：' + $lnk)
    Write-Detail '下次开机登录后会自动在后台启动服务（不弹黑窗口、不开窗口）。'
    Write-Detail '想取消，双击「开机自启-取消.cmd」即可。'
    Write-Detail '不需要管理员权限。'
    if (-not (Test-Path -LiteralPath $ServerJs -PathType Leaf)) {
        Write-Detail ('提醒：现在还没看到 server.js（' + $ServerJs + '），等它放进来之后自启才能正常工作。') 'warn'
    }
    return $ExitOk
}

function Remove-Autostart {
    Write-Step '1/2' '检查运行环境'
    $lnk = Get-StartupLnkPath
    Write-Detail ('快捷方式位置：' + $lnk)

    Write-Step '2/2' '取消开机自启'
    $existed = Test-Path -LiteralPath $lnk -PathType Leaf
    if ($existed) {
        try {
            Remove-Item -LiteralPath $lnk -Force
        } catch {
            Write-Detail ('删除失败：' + $_.Exception.Message) 'err'
            return $ExitFailed
        }
    }
    if (Test-Path -LiteralPath $lnk -PathType Leaf) {
        Write-Detail '删除后快捷方式仍然存在，请手动删除。' 'err'
        return $ExitFailed
    }
    Write-Detail '已取消开机自启' 'ok'
    if (-not $existed) { Write-Detail '（本来就没有设置过开机自启，无需清理）' 'warn' }
    Write-Detail '下次开机不会再自动启动服务。'
    return $ExitOk
}

# ================================================================ 主流程
if ($Help) { Show-Usage; exit $ExitOk }

if ($InstallAutostart) {
    Write-Head
    $code = Install-Autostart
    Write-Blank
    exit $code
}

if ($RemoveAutostart) {
    Write-Head
    $code = Remove-Autostart
    Write-Blank
    exit $code
}

Write-Head

# 参数兜底
if ($Port -lt 1 -or $Port -gt 65535) { $Port = 8788 }
$scanEnd = $PortRangeEnd
if ($Port -gt $scanEnd) { $scanEnd = $Port }

# ---------------------------------------------------------------- [1/4] Node.js
Write-Step '1/4' '检查 Node.js 运行环境'
$nodeExe = Resolve-NodePath
if (-not $nodeExe) {
    Write-Detail '没有找到 Node.js，无法在后台运行「今日事」服务。' 'err'
    Write-Blank
    Write-Host '  你有两个选择：' -ForegroundColor White
    Write-Host '    1) 安装 Node.js LTS 版（推荐）——装完之后再双击一次本脚本就好：' -ForegroundColor White
    Write-Host ('       ' + $NodeUrl) -ForegroundColor Cyan
    Write-Host '    2) 不装也能用——直接双击本目录里的 index.html，' -ForegroundColor White
    Write-Host '       功能一样能用，只是关掉页面之后就不会再提醒你了。' -ForegroundColor White
    Write-Blank
    Write-Detail '现在为你打开 Node.js 中文下载页……'
    try { Start-Process $NodeUrl } catch {
        Write-Detail '打不开浏览器，请手动复制上面的网址。' 'warn'
    }
    Write-Blank
    exit $ExitNoNode
}
Write-Detail ('已找到 Node.js：' + $nodeExe) 'ok'

# ---------------------------------------------------------------- [2/4] server.js + 端口
Write-Step '2/4' '检查后台服务文件与端口占用'
if (-not (Test-Path -LiteralPath $ServerJs -PathType Leaf)) {
    Write-Detail ('找不到后台服务文件：' + $ServerJs) 'err'
    Write-Detail '请确认 server.js 与 启动今日事.ps1 放在同一个文件夹里。' 'err'
    Write-Blank
    exit $ExitNoServer
}
Write-Detail ('后台服务文件：' + $ServerJs) 'ok'

$state = Get-PortState -StartPort $Port -EndPort $scanEnd

$busy = @($state.BusyPorts)
if ($busy.Count -gt 0) {
    Write-Detail ('端口 ' + ($busy -join '、') + ' 已被别的程序占用，自动跳过。') 'warn'
}

if ($state.ExistingPort -gt 0) {
    $info = $state.ExistingInfo
    $pidText = ''
    if ($info.PSObject.Properties['pid']) { $pidText = '，PID ' + $info.pid }
    Write-Detail ('发现「今日事」服务已经在运行：端口 ' + $state.ExistingPort + $pidText) 'ok'
} else {
    if ($state.FreePort -gt 0) {
        Write-Detail ('端口 ' + $state.FreePort + ' 空闲，可以用。') 'ok'
    } else {
        Write-Detail ('端口 ' + $Port + '-' + $scanEnd + ' 全都被别的程序占用了。') 'err'
        Write-Detail '请关掉占用这些端口的程序，或用 -Port 换一个起始端口再试。' 'err'
        Write-Blank
        exit $ExitNoPort
    }
}

# ---------------------------------------------------------------- [3/4] 启动 / 复用
$launchPort = 0
$started    = $null

if ($state.ExistingPort -gt 0 -and (-not $Restart)) {
    Write-Step '3/4' '复用已经在运行的后台服务'
    Write-Detail ('服务已经在端口 ' + $state.ExistingPort + ' 上跑着，不再启动第二个进程。') 'ok'
    $launchPort = $state.ExistingPort
}
else {
    if ($state.ExistingPort -gt 0) {
        # -Restart：先让旧服务退出
        Write-Step '3/4' '重新启动后台服务'
        Write-Detail ('按 -Restart 要求，先让端口 ' + $state.ExistingPort + ' 上的旧服务退出……')
        $quitOk = Invoke-Quit -TargetPort $state.ExistingPort
        if ($quitOk) { Write-Detail '已发送退出指令（POST /api/quit）。' 'ok' }
        else         { Write-Detail '退出指令没有响应，继续等端口释放……' 'warn' }

        $released = $false
        $deadline = (Get-Date).AddSeconds($QuitSeconds)
        while ((Get-Date) -lt $deadline) {
            if (-not (Test-PortBusy -TargetPort $state.ExistingPort -TimeoutMs 300)) { $released = $true; break }
            Start-Sleep -Milliseconds 200
        }

        if ($released) {
            Write-Detail ('旧服务已退出，端口 ' + $state.ExistingPort + ' 已释放。') 'ok'
            $launchPort = $state.ExistingPort
        } else {
            $still = Get-TodayServerInfo -TargetPort $state.ExistingPort -TimeoutMs 500
            if ($still) {
                Write-Detail ('旧服务在 ' + $QuitSeconds + ' 秒内没有退出，为避免两个进程抢同一个端口，本次不再启动。') 'err'
                Write-Detail '可以稍等片刻再试一次，或先手动结束它。' 'err'
                Write-Blank
                exit $ExitFailed
            }
            Write-Detail ('端口 ' + $state.ExistingPort + ' 已被别的程序占用，换一个端口。') 'warn'
            $state2 = Get-PortState -StartPort $Port -EndPort $scanEnd
            if ($state2.FreePort -gt 0) {
                $launchPort = $state2.FreePort
                Write-Detail ('改用空闲端口 ' + $launchPort + '。') 'ok'
            } else {
                Write-Detail '没有可用端口了。' 'err'
                Write-Blank
                exit $ExitNoPort
            }
        }
    } else {
        Write-Step '3/4' '启动后台服务'
        $launchPort = $state.FreePort
    }

    $startArgs = @('"' + $ServerJs + '"', '--port=' + $launchPort)
    Write-Detail ('启动命令：' + $nodeExe + ' ' + $ServerJs + ' --port=' + $launchPort)
    try {
        $started = Start-Process -FilePath $nodeExe -ArgumentList $startArgs `
                                 -WorkingDirectory $ScriptDir -WindowStyle Hidden -PassThru
    } catch {
        Write-Detail ('启动 Node.js 进程失败：' + $_.Exception.Message) 'err'
        Write-Blank
        exit $ExitFailed
    }
    if ($started) { Write-Detail ('已后台启动（PID ' + $started.Id + '），窗口是隐藏的。') 'ok' }
    else          { Write-Detail '已后台启动。' 'ok' }

    Write-Detail ('正在等待服务就绪（最多 ' + $ReadySeconds + ' 秒）……')
    $ready = $null
    $deadline = (Get-Date).AddSeconds($ReadySeconds)
    while ((Get-Date) -lt $deadline) {
        $ready = Get-TodayServerInfo -TargetPort $launchPort -TimeoutMs 500
        if ($ready) { break }
        Start-Sleep -Milliseconds 250
    }

    if (-not $ready) {
        Write-Detail ('启动失败，请查看 data\server.log 的最后几行') 'err'
        if ($started) {
            try {
                if ($started.HasExited) {
                    Write-Detail ('Node 进程已经退出了，退出码 ' + $started.ExitCode + '。') 'err'
                } else {
                    Write-Detail ('Node 进程还在（PID ' + $started.Id + '），但一直没响应。') 'warn'
                }
            } catch { }
        }
        $shown = Show-LogTail -Path $ServerLog -Label 'data\server.log'
        $shownErr = Show-LogTail -Path $ErrLog -Label 'data\server.err.log'
        if ((-not $shown) -and (-not $shownErr)) {
            Write-Blank
            Write-Detail '（现在还没有日志文件。可以在这个目录里手动跑一次 node server.js，看它报什么错。）' 'warn'
        }
        Write-Blank
        exit $ExitFailed
    }

    $okPid = ''
    if ($ready.PSObject.Properties['pid']) { $okPid = '，PID ' + $ready.pid }
    Write-Detail ('服务已就绪：端口 ' + $launchPort + $okPid) 'ok'
}

# ---------------------------------------------------------------- [4/4] 打开窗口
$url = 'http://127.0.0.1:' + $launchPort + '/?port=' + $launchPort

if ($NoOpen) {
    Write-Step '4/4' '跳过打开窗口'
    Write-Detail '已指定 -NoOpen，只保留后台服务。' 'ok'
    Write-Detail ('服务地址：http://127.0.0.1:' + $launchPort)
    Write-Blank
    exit $ExitOk
}

Write-Step '4/4' '打开应用窗口'
$edge = Resolve-EdgePath
if ($edge) {
    Write-Detail ('用 Edge 应用窗口模式打开：' + $url)
    try {
        Start-Process -FilePath $edge -ArgumentList @('--app=' + $url, '--window-size=1280,900')
        Write-Detail '窗口已打开（没有地址栏，关掉窗口服务仍在后台运行）。' 'ok'
    } catch {
        Write-Detail ('Edge 启动失败，改用默认浏览器。' ) 'warn'
        try { Start-Process $url } catch {
            Write-Detail '打开浏览器失败，请手动访问上面的地址。' 'warn'
        }
    }
} else {
    Write-Detail '没有找到 Edge，改用默认浏览器打开。' 'warn'
    try { Start-Process $url } catch {
        Write-Detail '打开浏览器失败，请手动访问上面的地址。' 'warn'
    }
}

Write-Blank
Write-Host '  今日事已经启动。' -ForegroundColor Green
Write-Blank
exit $ExitOk
