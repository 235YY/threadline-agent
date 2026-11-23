param([switch]$ReadForWorker, [switch]$StatusOnly)
$ErrorActionPreference = 'Stop'
# Node may inherit PowerShell 7's module path. Load the Windows host's own
# security module explicitly instead of depending on cross-version autoload.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
$secretDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '_local\study-secrets'
$secretPath = Join-Path $secretDirectory 'deepseek-study.dpapi'
if ($StatusOnly) { [Console]::Out.Write((Test-Path -LiteralPath $secretPath)); exit 0 }
if ($ReadForWorker) {
    # Only the worker captures stdout in memory. Never invoke this switch in a visible terminal.
    try {
        $secureValue = ConvertTo-SecureString (Get-Content -LiteralPath $secretPath -Raw)
        $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
        try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $secureValue.Dispose() }
        exit 0
    } catch { [Console]::Error.Write(('STUDY_KEY_UNAVAILABLE:' + $_.Exception.GetType().FullName + ':' + $_.Exception.HResult)); exit 1 }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$window = New-Object Windows.Forms.Form
$window.Text = 'DeepSeek 测试专用密钥'
$window.ClientSize = New-Object Drawing.Size(600,270)
$window.StartPosition = 'CenterScreen'
$window.FormBorderStyle = 'FixedDialog'
$window.MaximizeBox = $false
$label = New-Object Windows.Forms.Label
$label.Text = '从 DeepSeek 开放平台复制完整 key，点击右侧“粘贴”。这里不会发送 API 请求。'
$label.Location = New-Object Drawing.Point(18,18)
$label.Size = New-Object Drawing.Size(562,38)
$field = New-Object Windows.Forms.TextBox
$field.Location = New-Object Drawing.Point(18,65)
$field.Size = New-Object Drawing.Size(450,28)
$field.UseSystemPasswordChar = $true
$field.ShortcutsEnabled = $true
$field.MaxLength = 256
$pasteButton = New-Object Windows.Forms.Button
$pasteButton.Text = '粘贴'
$pasteButton.Location = New-Object Drawing.Point(482,61)
$pasteButton.Size = New-Object Drawing.Size(98,34)
# The clipboard is read only in this button handler, after the user's click.
$pasteAction = {
    try {
        if ([Windows.Forms.Clipboard]::ContainsText()) {
            $field.Text = [Windows.Forms.Clipboard]::GetText().Trim()
            $field.SelectionStart = $field.Text.Length
            $field.Focus()
        } else { [Windows.Forms.MessageBox]::Show('剪贴板里没有文字，请先在官网复制完整 key。','粘贴') | Out-Null }
    } catch { [Windows.Forms.MessageBox]::Show('暂时无法访问剪贴板，请稍后再点“粘贴”。','粘贴') | Out-Null }
}
$pasteButton.Add_Click($pasteAction)
$field.Add_KeyDown({
    param($sender,$keyEvent)
    if ($keyEvent.Control -and $keyEvent.KeyCode -eq [Windows.Forms.Keys]::V) {
        $keyEvent.SuppressKeyPress = $true
        & $pasteAction
    }
})
$formatLabel = New-Object Windows.Forms.Label
$formatLabel.Location = New-Object Drawing.Point(18,110)
$formatLabel.Size = New-Object Drawing.Size(560,27)
$formatLabel.Text = '仅检查输入格式，是否有效仍需由官方接口验证。'
$field.Add_TextChanged({ $formatLabel.Text = ('已输入 ' + $field.Text.Length + ' 个字符。格式正确不代表 key 一定有效。') })
$note = New-Object Windows.Forms.Label
$note.Text = '只加密保存在本机，不写进聊天、报告或日志。粘贴只在你按下按钮时发生。'
$note.Location = New-Object Drawing.Point(18,151)
$note.Size = New-Object Drawing.Size(560,42)
$saveButton = New-Object Windows.Forms.Button
$saveButton.Text = '保存到本机'
$saveButton.Location = New-Object Drawing.Point(340,215)
$saveButton.Size = New-Object Drawing.Size(112,34)
$cancelButton = New-Object Windows.Forms.Button
$cancelButton.Text = '取消'
$cancelButton.Location = New-Object Drawing.Point(468,215)
$cancelButton.Size = New-Object Drawing.Size(108,34)
$cancelButton.Add_Click({ $window.Close() })
$saveButton.Add_Click({
    $field.Text = $field.Text.Trim()
    if ($field.Text -notmatch '^sk-[A-Za-z0-9_-]{12,}$') {
        [Windows.Forms.MessageBox]::Show('请输入官网生成、以 sk- 开头的完整 key。请勿加引号或空格，建议直接粘贴。','检查格式') | Out-Null
        return
    }
    try {
        New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
        $secureValue = ConvertTo-SecureString $field.Text -AsPlainText -Force
        try { $encrypted = ConvertFrom-SecureString $secureValue }
        finally { $secureValue.Dispose() }
        # DPAPI binds the ciphertext to this Windows user; restrict file access too.
        $temporary = Join-Path $secretDirectory 'deepseek-study.new'
        [IO.File]::WriteAllText($temporary,$encrypted,[Text.Encoding]::ASCII)
        $acl = New-Object Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true,$false)
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
        Set-Acl -LiteralPath $temporary -AclObject $acl
        Move-Item -LiteralPath $temporary -Destination $secretPath -Force
        $field.Clear()
        [Windows.Forms.MessageBox]::Show('已加密保存。这里没有发送任何付费请求。','已保存') | Out-Null
        $window.Close()
    } catch {
        [Windows.Forms.MessageBox]::Show('保存失败，没有向 API 发送任何内容。','保存失败') | Out-Null
    }
})
$window.Controls.AddRange(@($label,$field,$pasteButton,$formatLabel,$note,$saveButton,$cancelButton))
$window.Add_Shown({ $window.Activate(); $field.Focus() })
$window.AcceptButton = $saveButton
$window.CancelButton = $cancelButton
try { $window.ShowDialog() | Out-Null } finally { $field.Clear(); $window.Dispose() }
