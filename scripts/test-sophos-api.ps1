$ErrorActionPreference = 'Stop'
Write-Host 'Sophos read-only DHCP test: 192.168.1.1:4444'
Write-Host 'Your password is used for this test only and is not saved.'
$trackerPassword = Read-Host 'Password for iptracker_sync' -AsSecureString
$trackerPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($trackerPassword)
try {
    $trackerCredentials = @{
        username = 'iptracker_sync'
        password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($trackerPointer)
    }
    $trackerCredentials | ConvertTo-Json -Compress | & node (Join-Path $PSScriptRoot 'test-sophos-api.js')
    if ($LASTEXITCODE -ne 0) { Write-Host 'Test did not succeed. Share the status message only, never the password.' }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($trackerPointer)
    if ($trackerCredentials) { $trackerCredentials.password = $null }
    $trackerPassword.Dispose()
}
