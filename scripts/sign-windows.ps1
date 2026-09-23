param(
    [Parameter(Mandatory)]
    [string]$FilePath,
    [Parameter(Mandatory)]
    [string]$PublisherName
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    throw "Signing input does not exist: $FilePath"
}
$FilePath = (Resolve-Path -LiteralPath $FilePath).Path

# Keep this version aligned with the installation step in release.yml.
Import-Module ArtifactSigning -RequiredVersion 0.1.8

$signingParameters = @{
    Endpoint = 'https://eus.codesigning.azure.net/'
    CodeSigningAccountName = 'theo-gibbons'
    CertificateProfileName = 'windows-app-signing-v3'
    Files = $FilePath
    FileDigest = 'SHA256'
    TimestampRfc3161 = 'http://timestamp.acs.microsoft.com'
    TimestampDigest = 'SHA256'
    # Use only the Azure CLI session established by azure/login's OIDC exchange.
    ExcludeEnvironmentCredential = $true
    ExcludeWorkloadIdentityCredential = $true
    ExcludeManagedIdentityCredential = $true
    ExcludeSharedTokenCacheCredential = $true
    ExcludeVisualStudioCredential = $true
    ExcludeVisualStudioCodeCredential = $true
    ExcludeAzureCliCredential = $false
    ExcludeAzurePowerShellCredential = $true
    ExcludeAzureDeveloperCliCredential = $true
    ExcludeInteractiveBrowserCredential = $true
}
Invoke-ArtifactSigning @signingParameters

# Every hook invocation must verify successfully before electron-builder can
# package this file or publish the installer and its updater metadata.
$signature = Get-AuthenticodeSignature -LiteralPath $FilePath
if ($signature.Status -ne 'Valid') {
    throw "Invalid signature on ${FilePath}: $($signature.Status) - $($signature.StatusMessage)"
}
if ($null -eq $signature.TimeStamperCertificate) {
    throw "Missing timestamp on $FilePath"
}
$actualPublisher = $signature.SignerCertificate.GetNameInfo(
    [System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false
)
if ($actualPublisher -cne $PublisherName) {
    throw "Publisher mismatch on ${FilePath}: expected '$PublisherName', got '$actualPublisher'. Check the certificate profile and release config."
}
Write-Host "Verified signature and timestamp: $FilePath (publisher: $actualPublisher)"
