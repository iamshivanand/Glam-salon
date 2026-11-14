<#
.SYNOPSIS
  Logical backup of the dockerised Glam Connect database (Windows dev/staging).

.DESCRIPTION
  Runs pg_dump inside the Postgres container and copies the custom-format dump
  to the host, then verifies it with pg_restore --list and prunes old files.

.EXAMPLE
  ./ops/backup.ps1
  ./ops/backup.ps1 -BackupDir D:\backups -RetentionDays 30
#>
param(
  [string]$BackupDir = "backups",
  [int]$RetentionDays = 14,
  [string]$Container = "glamconnect-postgres",
  [string]$Database = "glamconnect",
  [string]$User = "glam",
  [string]$Password = "glam_dev_pw"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $BackupDir)) {
  New-Item -ItemType Directory -Path $BackupDir | Out-Null
}

$stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
$name = "glamconnect-$stamp.dump"
$remote = "/tmp/$name"
$target = Join-Path $BackupDir $name

Write-Host "Dumping $Database from $Container ..."
docker exec -e "PGPASSWORD=$Password" $Container pg_dump -U $User -d $Database -Fc --no-owner --no-privileges -f $remote
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }

docker cp "${Container}:$remote" $target
if ($LASTEXITCODE -ne 0) { throw "docker cp failed with exit code $LASTEXITCODE" }
docker exec $Container rm -f $remote | Out-Null

Write-Host "Verifying $target ..."
docker exec -i $Container pg_restore --list - < $target | Out-Null
if ($LASTEXITCODE -ne 0) { throw "backup verification failed" }

$size = (Get-Item $target).Length
Write-Host "Verified $target ($size bytes)"

$cutoff = (Get-Date).AddDays(-$RetentionDays)
Get-ChildItem $BackupDir -Filter "glamconnect-*.dump" |
  Where-Object { $_.LastWriteTime -lt $cutoff } |
  ForEach-Object {
    Write-Host "Pruning $($_.Name)"
    Remove-Item $_.FullName
  }

Write-Host "Done."
