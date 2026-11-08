# Downloads the test papers from arXiv (they are not stored in this repository).
$papers = [ordered]@{
    "sample.pdf"            = "1706.03762"  # Attention Is All You Need
    "papers/1810.04805.pdf" = "1810.04805"  # BERT
    "papers/1512.03385.pdf" = "1512.03385"  # ResNet
    "papers/1412.6980.pdf"  = "1412.6980"   # Adam
    "papers/1312.6114.pdf"  = "1312.6114"   # VAE
    "papers/2006.11239.pdf" = "2006.11239"  # DDPM
}
New-Item -ItemType Directory -Force (Join-Path $PSScriptRoot "papers") | Out-Null
foreach ($name in $papers.Keys) {
    $out = Join-Path $PSScriptRoot $name
    if (Test-Path $out) { "skip $name"; continue }
    Invoke-WebRequest "https://arxiv.org/pdf/$($papers[$name])" -OutFile $out
    "got $name"
    Start-Sleep 3
}
