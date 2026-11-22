param(
 [Parameter(Mandatory=$true)][ValidateSet('status','exchange','access','forget')][string]$Operation,
 [Parameter(Mandatory=$true)][ValidatePattern('(?i)^[a-f0-9]{32}$')][string]$Namespace,
 [Parameter(Mandatory=$true)][string]$ClientFile
)
# K Colab OAuth helper. The owner's OAuth client file (client_secret) and the
# refresh token stay here: the refresh token lives only in Windows Credential
# Manager. Node receives the public client id, the account email and a short-lived
# access token; nothing else is printed. No browser, Chrome profile or other
# project's credential is read.
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$target="K-Harness.Colab.$($Namespace.ToLowerInvariant())"
$native=@'
using System;
using System.Runtime.InteropServices;
public static class KColabCredentialNative {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
 [DllImport("Advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
 [DllImport("Advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
 [DllImport("Advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] [return: MarshalAs(UnmanagedType.Bool)] static extern bool CredDelete(string target, uint type, uint flags);
 [DllImport("Advapi32.dll")] static extern void CredFree(IntPtr buffer);
 public static byte[] Read(string target){
  IntPtr ptr; if(!CredRead(target,1,0,out ptr)){if(Marshal.GetLastWin32Error()==1168)return null; throw new InvalidOperationException("CREDENTIAL");}
  try { var c=(CREDENTIAL)Marshal.PtrToStructure(ptr,typeof(CREDENTIAL)); var blob=new byte[(int)c.CredentialBlobSize]; if(blob.Length>0)Marshal.Copy(c.CredentialBlob,blob,0,blob.Length); return blob; }
  finally { CredFree(ptr); }
 }
 public static void Write(string target, byte[] blob){
  IntPtr p=Marshal.AllocHGlobal(blob.Length);
  try { Marshal.Copy(blob,0,p,blob.Length); var c=new CREDENTIAL{Type=1,TargetName=target,CredentialBlobSize=(uint)blob.Length,CredentialBlob=p,Persist=2,UserName="k-colab"}; if(!CredWrite(ref c,0))throw new InvalidOperationException("CREDENTIAL"); }
  finally { for(int i=0;i<blob.Length;i++)Marshal.WriteByte(p,i,0); Marshal.FreeHGlobal(p); }
 }
 public static bool Delete(string target){ if(CredDelete(target,1,0))return true; if(Marshal.GetLastWin32Error()==1168)return false; throw new InvalidOperationException("CREDENTIAL"); }
}
'@
function Out-Json($Value){[Console]::Out.WriteLine((ConvertTo-Json -InputObject $Value -Compress -Depth 4))}
function Fail([string]$Code){throw "KCOLAB:$Code"}
function Get-Client {
 if(-not (Test-Path -LiteralPath $ClientFile -PathType Leaf)){return $null}
 try {$json=Get-Content -LiteralPath $ClientFile -Raw -Encoding UTF8 | ConvertFrom-Json} catch {Fail 'client_invalid'}
 $c=$json.installed
 if($null -eq $c -or -not ($c.client_id -match '^[\w.-]+\.apps\.googleusercontent\.com$') -or -not $c.client_secret){Fail 'client_invalid'}
 return $c
}
function Get-Email([string]$IdToken){
 $parts=$IdToken.Split('.'); if($parts.Count -lt 2){Fail 'id_token_invalid'}
 $p=$parts[1].Replace('-','+').Replace('_','/'); switch($p.Length % 4){2{$p+='=='}3{$p+='='}}
 $claims=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p)) | ConvertFrom-Json
 if($claims.iss -notin @('https://accounts.google.com','accounts.google.com') -or $claims.email_verified -ne $true -or -not $claims.email){Fail 'id_token_invalid'}
 return [string]$claims.email
}
function Invoke-Token($Form){
 try {return Invoke-RestMethod -Method Post -Uri 'https://oauth2.googleapis.com/token' -Body $Form -ContentType 'application/x-www-form-urlencoded' -TimeoutSec 30}
 catch {
  $code='token_failed'
  try {$body=(New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() | ConvertFrom-Json; if($body.error -in @('invalid_grant','invalid_client','unauthorized_client','access_denied')){$code=$body.error}} catch {}
  Fail $code
 }
}
try {
 Add-Type -TypeDefinition $native -ErrorAction Stop
 $client=Get-Client
 switch($Operation){
  'status' {
   $blob=[KColabCredentialNative]::Read($target); $email=$null
   if($null -ne $blob){try{$email=([Text.Encoding]::UTF8.GetString($blob) | ConvertFrom-Json).email}catch{}; [Array]::Clear($blob,0,$blob.Length)}
   Out-Json @{client=($null -ne $client);clientId=$(if($client){$client.client_id}else{$null});signedIn=($null -ne $blob);email=$email}
  }
  'exchange' {
   if($null -eq $client){Fail 'client_missing'}
   $in=[Console]::In.ReadToEnd() | ConvertFrom-Json
   if(-not ($in.redirectUri -match '^http://127\.0\.0\.1:\d{1,5}/callback$') -or -not $in.code -or -not $in.verifier){Fail 'input_invalid'}
   $r=Invoke-Token @{grant_type='authorization_code';code=$in.code;code_verifier=$in.verifier;redirect_uri=$in.redirectUri;client_id=$client.client_id;client_secret=$client.client_secret}
   if(-not $r.refresh_token -or -not $r.access_token -or -not $r.id_token){Fail 'token_incomplete'}
   $email=Get-Email $r.id_token
   if($in.expectedAccount -and $email.ToLowerInvariant() -ne ([string]$in.expectedAccount).ToLowerInvariant()){Out-Json @{error='account_mismatch';email=$email};break}
   [KColabCredentialNative]::Write($target,[Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -Compress @{refreshToken=$r.refresh_token;email=$email})))
   Out-Json @{accessToken=$r.access_token;expiresIn=[int]$r.expires_in;email=$email}
  }
  'access' {
   if($null -eq $client){Fail 'client_missing'}
   $blob=[KColabCredentialNative]::Read($target); if($null -eq $blob){Out-Json @{error='signed_out'};break}
   $saved=[Text.Encoding]::UTF8.GetString($blob) | ConvertFrom-Json; [Array]::Clear($blob,0,$blob.Length)
   try {$r=Invoke-Token @{grant_type='refresh_token';refresh_token=$saved.refreshToken;client_id=$client.client_id;client_secret=$client.client_secret}}
   catch {if("$_" -match 'KCOLAB:invalid_grant'){[void][KColabCredentialNative]::Delete($target);Out-Json @{error='signed_out'};break};throw}
   Out-Json @{accessToken=$r.access_token;expiresIn=[int]$r.expires_in;email=$saved.email}
  }
  'forget' {Out-Json @{removed=[KColabCredentialNative]::Delete($target)}}
 }
} catch {
 $m="$_"; $code=if($m -match 'KCOLAB:([a-z_]+)'){$Matches[1]}elseif($m -match 'CREDENTIAL'){'credential'}else{'unknown'}
 Out-Json @{error=$code}
 exit 1
}
