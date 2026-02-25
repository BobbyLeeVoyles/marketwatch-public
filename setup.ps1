# Marketwatch Setup & Launcher
# Double-click setup.bat to run this

try {

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$dir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

# Load existing .env if present
function Read-Env {
    $values = @{}
    $envFile = Join-Path $dir ".env"
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match "^([^#][^=]*)=(.*)$") {
                $values[$matches[1].Trim()] = $matches[2].Trim()
            }
        }
    }
    return $values
}
$existing = Read-Env

# Colors & fonts
$navy    = [System.Drawing.Color]::FromArgb(18, 22, 43)
$surface = [System.Drawing.Color]::FromArgb(30, 37, 64)
$cyan    = [System.Drawing.Color]::FromArgb(0, 217, 255)
$white   = [System.Drawing.Color]::White
$muted   = [System.Drawing.Color]::FromArgb(139, 146, 184)
$green   = [System.Drawing.Color]::FromArgb(0, 255, 65)
$yellow  = [System.Drawing.Color]::FromArgb(255, 170, 0)
$red     = [System.Drawing.Color]::FromArgb(255, 0, 68)

$fontTitle  = New-Object System.Drawing.Font("Consolas", 13, [System.Drawing.FontStyle]::Bold)
$fontNormal = New-Object System.Drawing.Font("Consolas", 9)
$fontSmall  = New-Object System.Drawing.Font("Consolas", 8)
$fontBtn    = New-Object System.Drawing.Font("Consolas", 11, [System.Drawing.FontStyle]::Bold)

function Add-Label($form, $text, $x, $y, $w, $h, $color, $font) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $text
    $l.Location = New-Object System.Drawing.Point($x, $y)
    $l.Size = New-Object System.Drawing.Size($w, $h)
    $l.ForeColor = $color
    $l.BackColor = [System.Drawing.Color]::Transparent
    if ($font) { $l.Font = $font }
    $form.Controls.Add($l)
    return $l
}

function Add-TextBox($form, $x, $y, $w, $default) {
    $t = New-Object System.Windows.Forms.TextBox
    $t.Location = New-Object System.Drawing.Point($x, $y)
    $t.Size = New-Object System.Drawing.Size($w, 26)
    $t.BackColor = $surface
    $t.ForeColor = $white
    $t.BorderStyle = "FixedSingle"
    $t.Font = $fontNormal
    if ($default) { $t.Text = $default }
    $form.Controls.Add($t)
    return $t
}

# Build form
$form = New-Object System.Windows.Forms.Form
$form.Text = "Marketwatch Setup"
$form.Size = New-Object System.Drawing.Size(500, 500)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.BackColor = $navy

# Title
Add-Label $form "MARKETWATCH SETUP" 20 18 460 28 $cyan $fontTitle | Out-Null
Add-Label $form "Enter your credentials and click Launch." 20 48 460 18 $muted $fontSmall | Out-Null

# Kalshi Key ID
Add-Label $form "Kalshi API Key ID" 20 82 300 18 $white $fontNormal | Out-Null
$kalshiBox = Add-TextBox $form 20 102 450 $existing["KALSHI_API_KEY_ID"]
Add-Label $form "kalshi.com -> Settings -> API Keys" 20 130 350 16 $muted $fontSmall | Out-Null

# PEM file
Add-Label $form "Kalshi Private Key (.pem file)" 20 156 300 18 $white $fontNormal | Out-Null
$pemBox = Add-TextBox $form 20 176 355 $existing["KALSHI_PRIVATE_KEY_PATH"]

$browseBtn = New-Object System.Windows.Forms.Button
$browseBtn.Text = "Browse..."
$browseBtn.Location = New-Object System.Drawing.Point(383, 175)
$browseBtn.Size = New-Object System.Drawing.Size(87, 28)
$browseBtn.BackColor = $surface
$browseBtn.ForeColor = $white
$browseBtn.FlatStyle = "Flat"
$browseBtn.Font = $fontSmall
$browseBtn.Add_Click({
    $dlg = New-Object System.Windows.Forms.OpenFileDialog
    $dlg.Filter = "PEM files (*.pem)|*.pem|All files (*.*)|*.*"
    $dlg.Title = "Select your Kalshi private key"
    if ($dlg.ShowDialog() -eq "OK") { $pemBox.Text = $dlg.FileName }
})
$form.Controls.Add($browseBtn)
Add-Label $form "Downloaded from Kalshi when you created your API key" 20 206 430 16 $muted $fontSmall | Out-Null

# xAI Key
Add-Label $form "xAI API Key (optional - only needed for Grok bots)" 20 232 440 18 $muted $fontNormal | Out-Null
$xaiBox = Add-TextBox $form 20 252 450 $existing["XAI_API_KEY"]
Add-Label $form "console.x.ai  -  leave blank if not using AI bots" 20 280 400 16 $muted $fontSmall | Out-Null

# Demo mode
$demoCheck = New-Object System.Windows.Forms.CheckBox
$demoCheck.Text = "Demo mode (fake money - recommended for first run)"
$demoCheck.ForeColor = $white
$demoCheck.Font = $fontSmall
$demoCheck.Location = New-Object System.Drawing.Point(20, 310)
$demoCheck.Size = New-Object System.Drawing.Size(450, 22)
$demoCheck.Checked = ($existing["KALSHI_DEMO_MODE"] -ne "false")
$demoCheck.BackColor = [System.Drawing.Color]::Transparent
$form.Controls.Add($demoCheck)

# Status label
$statusLabel = Add-Label $form "" 20 342 450 20 $green $fontSmall

# Launch button
$launchBtn = New-Object System.Windows.Forms.Button
$launchBtn.Text = "SET UP & LAUNCH"
$launchBtn.Location = New-Object System.Drawing.Point(20, 368)
$launchBtn.Size = New-Object System.Drawing.Size(450, 50)
$launchBtn.BackColor = $cyan
$launchBtn.ForeColor = [System.Drawing.Color]::Black
$launchBtn.Font = $fontBtn
$launchBtn.FlatStyle = "Flat"
$form.Controls.Add($launchBtn)

$launchBtn.Add_Click({

    if ([string]::IsNullOrWhiteSpace($kalshiBox.Text)) {
        [System.Windows.Forms.MessageBox]::Show("Please enter your Kalshi API Key ID.", "Missing Field", "OK", "Warning")
        return
    }
    $pemPath = $pemBox.Text.Trim()
    if ([string]::IsNullOrWhiteSpace($pemPath)) {
        [System.Windows.Forms.MessageBox]::Show("Please select your Kalshi private key (.pem) file.", "Missing File", "OK", "Warning")
        return
    }

    $launchBtn.Enabled = $false
    $launchBtn.Text = "Working..."

    # Copy PEM into project root
    $destPem = Join-Path $dir "kalshi-private-key.pem"
    if ((Test-Path $pemPath) -and ($pemPath -ne $destPem)) {
        Copy-Item $pemPath $destPem -Force
    }

    # Write .env
    $statusLabel.ForeColor = $green
    $statusLabel.Text = "Saving credentials..."
    $form.Refresh()

    $demo = if ($demoCheck.Checked) { "true" } else { "false" }
    $envLines = @(
        "KALSHI_API_KEY_ID=$($kalshiBox.Text.Trim())",
        "KALSHI_PRIVATE_KEY_PATH=./kalshi-private-key.pem",
        "KALSHI_DEMO_MODE=$demo",
        "XAI_API_KEY=$($xaiBox.Text.Trim())"
    )
    [System.IO.File]::WriteAllText((Join-Path $dir ".env"), ($envLines -join "`r`n"))

    # Check / install Node.js
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        $statusLabel.ForeColor = $yellow
        $statusLabel.Text = "Downloading Node.js - this takes a minute..."
        $form.Refresh()

        try {
            $releases = Invoke-RestMethod "https://nodejs.org/dist/index.json" -UseBasicParsing
            $lts      = $releases | Where-Object { $_.lts } | Select-Object -First 1
            $ver      = $lts.version
            $url      = "https://nodejs.org/dist/$ver/node-$ver-x64.msi"
            $msi      = "$env:TEMP\node-installer.msi"

            Invoke-WebRequest -Uri $url -OutFile $msi -UseBasicParsing

            $statusLabel.Text = "Installing Node.js..."
            $form.Refresh()

            Start-Process msiexec.exe -ArgumentList "/I `"$msi`" /quiet /norestart" -Wait

            $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" +
                        [System.Environment]::GetEnvironmentVariable("PATH", "User")
        }
        catch {
            $statusLabel.ForeColor = $red
            $statusLabel.Text = "Node.js install failed."
            [System.Windows.Forms.MessageBox]::Show("Could not install Node.js automatically.`n`nPlease install it manually from nodejs.org then run setup again.", "Install Failed", "OK", "Error")
            $launchBtn.Enabled = $true
            $launchBtn.Text = "SET UP & LAUNCH"
            return
        }
    }

    # npm install (skip if node_modules already exists)
    $nodeModules = Join-Path $dir "node_modules"
    if (-not (Test-Path $nodeModules)) {
        $statusLabel.ForeColor = $yellow
        $statusLabel.Text = "Installing packages - please wait (1-2 minutes)..."
        $form.Refresh()

        $npmCmd = if (Test-Path "$env:ProgramFiles\nodejs\npm.cmd") {
            "$env:ProgramFiles\nodejs\npm.cmd"
        } else { "npm" }

        $result = Start-Process "cmd.exe" -ArgumentList "/c `"$npmCmd`" install" -WorkingDirectory $dir -Wait -PassThru -WindowStyle Normal

        if ($result.ExitCode -ne 0) {
            $statusLabel.ForeColor = $red
            $statusLabel.Text = "Package install failed."
            [System.Windows.Forms.MessageBox]::Show("npm install failed.`n`nTry running it manually:`n  1. Open cmd in this folder`n  2. Type: npm install", "Install Failed", "OK", "Error")
            $launchBtn.Enabled = $true
            $launchBtn.Text = "SET UP & LAUNCH"
            return
        }
    }

    # Launch
    $statusLabel.ForeColor = $green
    $statusLabel.Text = "Launching..."
    $form.Refresh()

    Start-Process "cmd.exe" -ArgumentList "/k cd /d `"$dir`" && npm run dev"
    Start-Sleep -Seconds 4
    Start-Process "cmd.exe" -ArgumentList "/k cd /d `"$dir`" && npm run engine -- --mode=bots"
    Start-Sleep -Seconds 3
    Start-Process "http://localhost:3000"

    $statusLabel.Text = "Done! Dashboard is opening in your browser."
    $launchBtn.Text = "RUNNING"
})

[void]$form.ShowDialog()

} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show("Setup error:`n`n$_`n`nLine: $($_.InvocationInfo.ScriptLineNumber)", "Setup Error", "OK", "Error")
}
