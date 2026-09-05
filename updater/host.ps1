$ErrorActionPreference = "Stop"

function Read-NativeMessage {
    $stdin = [System.Console]::OpenStandardInput()
    $lengthBytes = New-Object byte[] 4
    $read = $stdin.Read($lengthBytes, 0, 4)
    if ($read -lt 4) { return $null }
    $length = [System.BitConverter]::ToInt32($lengthBytes, 0)
    $buffer = New-Object byte[] $length
    $readTotal = 0
    while ($readTotal -lt $length) {
        $r = $stdin.Read($buffer, $readTotal, $length - $readTotal)
        if ($r -le 0) { break }
        $readTotal += $r
    }
    $jsonText = [System.Text.Encoding]::UTF8.GetString($buffer)
    return ConvertFrom-Json $jsonText
}

function Send-NativeMessage($obj) {
    $stdout = [System.Console]::OpenStandardOutput()
    $json = ConvertTo-Json -Compress -InputObject $obj
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $lenBytes = [System.BitConverter]::GetBytes([int]$bytes.Length)
    $stdout.Write($lenBytes, 0, 4)
    $stdout.Write($bytes, 0, $bytes.Length)
    $stdout.Flush()
}

$repo = "assasakiy/Smart-Subtitle"
$rootDir = (Get-Item $PSScriptRoot).Parent.FullName

while ($true) {
    $msg = Read-NativeMessage
    if ($null -eq $msg) { break }

    if ($msg.action -eq "ping") {
        Send-NativeMessage @{ success = $true; status = "connected" }
    }
    elseif ($msg.action -eq "update") {
        try {
            $downloadUrl = $msg.downloadUrl
            if ([string]::IsNullOrEmpty($downloadUrl)) {
                $downloadUrl = "https://github.com/$repo/archive/refs/heads/main.zip"
            }
            $tempZip = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "smart-sub-update.zip")
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $downloadUrl -OutFile $tempZip -UseBasicParsing
            
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $zip = [System.IO.Compression.ZipFile]::OpenRead($tempZip)
            $firstFolder = ($zip.Entries | Select-Object -First 1).FullName.Split('/')[0]
            
            foreach ($entry in $zip.Entries) {
                if ($entry.FullName.EndsWith("/")) { continue }
                $rel = $entry.FullName
                if ($firstFolder -and $rel.StartsWith("$firstFolder/")) {
                    $rel = $rel.Substring($firstFolder.Length + 1)
                }
                if ([string]::IsNullOrEmpty($rel)) { continue }
                $dest = [System.IO.Path]::Combine($rootDir, $rel)
                $destDir = [System.IO.Path]::GetDirectoryName($dest)
                if (-not (Test-Path $destDir)) { New-Item -ItemType Directory -Path $destDir -Force | Out-Null }
                [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
            }
            $zip.Dispose()
            Remove-Item $tempZip -Force -ErrorAction SilentlyContinue

            Send-NativeMessage @{ success = $true; message = "Pembaruan diterapkan via PowerShell." }
        }
        catch {
            Send-NativeMessage @{ success = $false; error = $_.Exception.Message }
        }
    }
    else {
        Send-NativeMessage @{ success = $false; error = "Aksi tidak diizinkan." }
    }
}
