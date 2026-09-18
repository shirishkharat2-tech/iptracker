$ErrorActionPreference = 'Stop'

# Windows DPAPI encrypts the password for the current Windows user and machine.
# Keep the credential outside the website and project directory.
$trackerSecretDirectory = Join-Path $env:LOCALAPPDATA 'IPTracker\Sophos'
$trackerSecretFile = Join-Path $trackerSecretDirectory '192.168.1.1-4444.credential.xml'

Write-Host 'Set up Sophos read-only credentials for 192.168.1.1:4444'
Write-Host 'The account is tested before its password is saved with Windows encryption.'
Write-Host 'This does not enable automatic sync or change the firewall.'
$trackerSecurePassword = Read-Host 'Password for iptracker_sync' -AsSecureString
if ($trackerSecurePassword.Length -eq 0) {
    $trackerSecurePassword.Dispose()
    throw 'Password cannot be empty. Nothing saved.'
}

$trackerPointer = [IntPtr]::Zero
$trackerInput = $null
try {
    $trackerPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($trackerSecurePassword)
    $trackerInput = @{
        username = 'iptracker_sync'
        password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($trackerPointer)
    }
    $trackerInput | ConvertTo-Json -Compress | & node (Join-Path $PSScriptRoot 'test-sophos-api.js')
    if ($LASTEXITCODE -ne 0) { throw 'Read-only API test failed. Stored credentials were not changed.' }

    New-Item -ItemType Directory -Path $trackerSecretDirectory -Force | Out-Null
    $trackerIdentity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $trackerAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $trackerAcl.SetOwner($trackerIdentity.User)
    $trackerAcl.SetAccessRuleProtection($true, $false)
    $trackerRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $trackerIdentity.User, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow'
    )
    $trackerAcl.AddAccessRule($trackerRule)
    Set-Acl -LiteralPath $trackerSecretDirectory -AclObject $trackerAcl

    $trackerCredential = New-Object System.Management.Automation.PSCredential('iptracker_sync', $trackerSecurePassword)
    $trackerTemporaryFile = Join-Path $trackerSecretDirectory ([Guid]::NewGuid().ToString() + '.tmp')
    try {
        $trackerCredential | Export-Clixml -LiteralPath $trackerTemporaryFile
        # Confirm this Windows account can read the protected credential back.
        $trackerReloaded = Import-Clixml -LiteralPath $trackerTemporaryFile
        if ($trackerReloaded -isnot [System.Management.Automation.PSCredential] -or $trackerReloaded.UserName -ne 'iptracker_sync') {
            throw 'Credential verification failed.'
        }
        $trackerReloaded.Password.Dispose()
        Move-Item -LiteralPath $trackerTemporaryFile -Destination $trackerSecretFile -Force
    } finally {
        if (Test-Path -LiteralPath $trackerTemporaryFile) { Remove-Item -LiteralPath $trackerTemporaryFile }
    }
    Write-Host ''
    Write-Host 'SETUP COMPLETE: Sophos credentials saved with Windows encryption.' -ForegroundColor Green
    Write-Host ('Windows account: ' + $trackerIdentity.Name)
    Write-Host 'Run the dashboard under this same Windows account on this computer.'
    Write-Host 'No reservations imported yet. Automatic sync is not enabled yet.'
} finally {
    if ($trackerInput) { $trackerInput.password = $null }
    if ($trackerPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($trackerPointer) }
    $trackerSecurePassword.Dispose()
}
