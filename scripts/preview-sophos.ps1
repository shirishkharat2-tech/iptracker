$ErrorActionPreference = 'Stop'
$trackerPath = Join-Path $env:LOCALAPPDATA 'IPTracker\Sophos\192.168.1.1-4444.credential.xml'
$trackerCredential = Import-Clixml -LiteralPath $trackerPath
$trackerPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($trackerCredential.Password)
try {
    $trackerInput = @{username=$trackerCredential.UserName;password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($trackerPointer)}
    $trackerResponse = $trackerInput | ConvertTo-Json -Compress | & node (Join-Path $PSScriptRoot 'test-sophos-api.js') --preview
    if ($LASTEXITCODE -ne 0) { throw 'Sophos read failed. No preview updated.' }
    $trackerXmlText = ($trackerResponse | ConvertFrom-Json).xml
    $trackerReaderSettings = New-Object System.Xml.XmlReaderSettings
    $trackerReaderSettings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
    $trackerReaderSettings.XmlResolver = $null
    $trackerReader = [System.Xml.XmlReader]::Create([System.IO.StringReader]::new($trackerXmlText), $trackerReaderSettings)
    $trackerXml = New-Object System.Xml.XmlDocument
    $trackerXml.XmlResolver = $null
    try { $trackerXml.Load($trackerReader) } finally { $trackerReader.Dispose() }
    $trackerServers = @($trackerXml.SelectNodes('//DHCPServer[Name]'))
    $trackerRecords = @(
      foreach ($trackerServer in $trackerServers) {
        foreach ($trackerLease in $trackerServer.SelectNodes('./StaticLease/Lease')) {
          [pscustomobject]@{ip=[string]$trackerLease.IPAddress;mac=[string]$trackerLease.MACAddress;host=[string]$trackerLease.HostName;dhcpServer=[string]$trackerServer.Name;interface=[string]$trackerServer.Interface}
        }
      }
    )
    $trackerPreview = @{fetchedAt=[DateTime]::UtcNow.ToString('o');firewall='192.168.1.1:4444';serverCount=$trackerServers.Count;records=$trackerRecords}
    $trackerOutput = Join-Path $PSScriptRoot '..\data\sophos-preview.json'
    [IO.File]::WriteAllText($trackerOutput, ($trackerPreview | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    Write-Host "PREVIEW READY: $($trackerServers.Count) DHCP configurations; $($trackerRecords.Count) reservations. No assignments imported."
} finally {
    $trackerInput.password = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($trackerPointer)
    $trackerCredential.Password.Dispose()
}
