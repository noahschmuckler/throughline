#Requires -Version 5.1
<#
.SYNOPSIS
    Export the currently-selected Outlook email conversation to:
      - a Desktop folder named from the conversation subject + latest timestamp
      - a Markdown file inside that folder
      - an "attachments" subfolder containing all attachments from the thread

.DESCRIPTION
    - Uses Outlook desktop COM APIs
    - Walks the entire selected message's conversation thread
    - Saves all attachments (including inline images) to attachments\
    - Converts HTML body to lightweight Markdown
    - Replaces inline cid: references with Markdown image/link references
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------
# Helpers
# ---------------------------

function Get-SafeName {
    param(
        [Parameter(Mandatory)]
        [string]$Name,
        [int]$MaxLength = 120
    )

    $safe = $Name.Trim()

    # Remove common RE:/FW: noise from folder/file naming
    $safe = $safe -replace '^(?i)\s*((RE|FW|FWD)\s*:\s*)+', ''

    # Replace invalid filename chars
    $invalid = [System.IO.Path]::GetInvalidFileNameChars()
    foreach ($ch in $invalid) {
        $safe = $safe.Replace($ch, '_')
    }

    # Collapse whitespace
    $safe = [regex]::Replace($safe, '\s+', ' ').Trim()

    # Trim trailing periods/spaces
    $safe = $safe.TrimEnd('.', ' ')

    if ([string]::IsNullOrWhiteSpace($safe)) {
        $safe = "EmailChain"
    }

    if ($safe.Length -gt $MaxLength) {
        $safe = $safe.Substring(0, $MaxLength).Trim()
    }

    return $safe
}

function Get-UniqueFilePath {
    param(
        [Parameter(Mandatory)]
        [string]$Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $Path
    }

    $dir  = [System.IO.Path]::GetDirectoryName($Path)
    $name = [System.IO.Path]::GetFileNameWithoutExtension($Path)
    $ext  = [System.IO.Path]::GetExtension($Path)

    $i = 2
    do {
        $candidate = Join-Path $dir ("{0} ({1}){2}" -f $name, $i, $ext)
        $i++
    } while (Test-Path -LiteralPath $candidate)

    return $candidate
}

function Normalize-ContentId {
    param([string]$ContentId)

    if ([string]::IsNullOrWhiteSpace($ContentId)) { return $null }

    $cid = $ContentId.Trim()
    $cid = $cid.Trim('<','>')
    return $cid.ToLowerInvariant()
}

function Get-AttachmentMetadata {
    param(
        [Parameter(Mandatory)]
        $MailItem,
        [Parameter(Mandatory)]
        [string]$AttachmentsFolder
    )

    # Outlook MAPI property tags
    $PR_ATTACH_CONTENT_ID  = "http://schemas.microsoft.com/mapi/proptag/0x3712001F"
    $PR_ATTACH_CONTENT_LOC = "http://schemas.microsoft.com/mapi/proptag/0x3713001F"

    $results = New-Object System.Collections.ArrayList
    $seenNames = @{}

    foreach ($att in $MailItem.Attachments) {
        # Best available display file name
        $originalName = $att.FileName
        if ([string]::IsNullOrWhiteSpace($originalName)) {
            $originalName = "attachment.bin"
        }

        $safeFileName = Get-SafeName -Name $originalName -MaxLength 180

        # Preserve extension if sanitization stripped too much
        if ([string]::IsNullOrWhiteSpace([System.IO.Path]::GetExtension($safeFileName)) -and
            -not [string]::IsNullOrWhiteSpace([System.IO.Path]::GetExtension($originalName))) {
            $safeFileName += [System.IO.Path]::GetExtension($originalName)
        }

        # Avoid collisions across the entire thread
        if ($seenNames.ContainsKey($safeFileName)) {
            $seenNames[$safeFileName]++
            $base = [System.IO.Path]::GetFileNameWithoutExtension($safeFileName)
            $ext  = [System.IO.Path]::GetExtension($safeFileName)
            $safeFileName = "{0} ({1}){2}" -f $base, $seenNames[$safeFileName], $ext
        }
        else {
            $seenNames[$safeFileName] = 1
        }

        $targetPath = Join-Path $AttachmentsFolder $safeFileName
        $targetPath = Get-UniqueFilePath -Path $targetPath

        # Save attachment
        $att.SaveAsFile($targetPath)

        # Try to read inline identifiers
        $contentId = $null
        $contentLocation = $null
        try {
            $contentId = $att.PropertyAccessor.GetProperty($PR_ATTACH_CONTENT_ID)
        } catch {}
        try {
            $contentLocation = $att.PropertyAccessor.GetProperty($PR_ATTACH_CONTENT_LOC)
        } catch {}

        $meta = [PSCustomObject]@{
            FileName        = [System.IO.Path]::GetFileName($targetPath)
            FullPath        = $targetPath
            RelativePath    = ("attachments/" + [System.IO.Path]::GetFileName($targetPath)).Replace('\','/')
            ContentId       = Normalize-ContentId $contentId
            ContentLocation = if ($contentLocation) { $contentLocation.Trim().ToLowerInvariant() } else { $null }
            IsLikelyImage   = ([System.IO.Path]::GetExtension($targetPath) -match '^\.(png|jpg|jpeg|gif|bmp|webp|tif|tiff|svg)$')
        }

        [void]$results.Add($meta)
    }

    return @($results)
}

function Convert-HtmlToMarkdown {
    param(
        [Parameter(Mandatory)]
        [string]$Html,

        [array]$AttachmentMetadata
    )

    if (-not $AttachmentMetadata) {
        $AttachmentMetadata = @()
    }

    if ([string]::IsNullOrWhiteSpace($Html)) {
        return ""
    }
    
    if ($null -eq $AttachmentMetadata) { $AttachmentMetadata = @() }

    $text = $Html

    # Remove scripts/styles/head
    $text = [regex]::Replace($text, '(?is)<script\b.*?</script>', '')
    $text = [regex]::Replace($text, '(?is)<style\b.*?</style>', '')
    $text = [regex]::Replace($text, '(?is)<head\b.*?</head>', '')

    # Build lookup maps
    $cidMap = @{}
    $locMap = @{}
    $nameMap = @{}

    foreach ($a in $AttachmentMetadata) {
        if ($a.ContentId) {
            $cidMap[$a.ContentId] = $a
        }
        if ($a.ContentLocation) {
            $locMap[$a.ContentLocation] = $a
        }
        if ($a.FileName) {
            $nameMap[$a.FileName.ToLowerInvariant()] = $a
        }
    }

    # Replace IMG tags inline using CID or content location
    $text = [regex]::Replace(
        $text,
        '(?is)<img\b[^>]*?src\s*=\s*["'']([^"'']+)["''][^>]*?>',
        {
            param($m)
            $src = $m.Groups[1].Value.Trim()
            $srcLower = $src.ToLowerInvariant()

            $attachment = $null

            if ($srcLower.StartsWith('cid:')) {
                $cid = Normalize-ContentId ($src.Substring(4))
                if ($cid -and $cidMap.ContainsKey($cid)) {
                    $attachment = $cidMap[$cid]
                }
            }
            elseif ($locMap.ContainsKey($srcLower)) {
                $attachment = $locMap[$srcLower]
            }
            else {
                # fallback by filename
                $leaf = [System.IO.Path]::GetFileName($srcLower)
                if ($leaf -and $nameMap.ContainsKey($leaf)) {
                    $attachment = $nameMap[$leaf]
                }
            }

            if ($attachment) {
                if ($attachment.IsLikelyImage) {
                    return "`n![$($attachment.FileName)]($($attachment.RelativePath))`n"
                } else {
                    return "`n[Embedded content: $($attachment.FileName)]($($attachment.RelativePath))`n"
                }
            }

            # If unresolved, preserve the source for manual inspection
            return "`n[Embedded content: $src]($src)`n"
        }
    )

    # Replace anchor tags
    $text = [regex]::Replace(
        $text,
        '(?is)<a\b[^>]*?href\s*=\s*["'']([^"'']+)["''][^>]*?>(.*?)</a>',
        {
            param($m)
            $href  = $m.Groups[1].Value.Trim()
            $label = $m.Groups[2].Value

            $label = [regex]::Replace($label, '(?is)<.*?>', '')
            $label = [System.Web.HttpUtility]::HtmlDecode($label).Trim()

            if ([string]::IsNullOrWhiteSpace($label)) { $label = $href }

            return "[$label]($href)"
        }
    )

    # Basic block-level conversions
    $text = [regex]::Replace($text, '(?is)<br\s*/?>', "`n")
    $text = [regex]::Replace($text, '(?is)</p\s*>', "`n`n")
    $text = [regex]::Replace($text, '(?is)<p\b[^>]*>', '')
    $text = [regex]::Replace($text, '(?is)</div\s*>', "`n")
    $text = [regex]::Replace($text, '(?is)<div\b[^>]*>', '')
    $text = [regex]::Replace($text, '(?is)</li\s*>', "`n")
    $text = [regex]::Replace($text, '(?is)<li\b[^>]*>', '- ')
    $text = [regex]::Replace($text, '(?is)</tr\s*>', "`n")
    $text = [regex]::Replace($text, '(?is)<tr\b[^>]*>', '')
    $text = [regex]::Replace($text, '(?is)</t[dh]\s*>', ' | ')
    $text = [regex]::Replace($text, '(?is)<t[dh]\b[^>]*>', '')
    $text = [regex]::Replace($text, '(?is)</h([1-6])\s*>', "`n`n")
    $text = [regex]::Replace(
        $text,
        '(?is)<h([1-6])\b[^>]*>(.*?)',
        {
            param($m)
            $level = [int]$m.Groups[1].Value
            $content = $m.Groups[2].Value
            $content = [regex]::Replace($content, '(?is)<.*?>', '')
            $content = [System.Web.HttpUtility]::HtmlDecode($content).Trim()
            if ([string]::IsNullOrWhiteSpace($content)) { return "" }
            return ("`n" + ('#' * $level) + " " + $content)
        }
    )

    # Strip the rest of HTML tags
    $text = [regex]::Replace($text, '(?is)<[^>]+>', '')

    # Decode HTML entities
    $text = [System.Web.HttpUtility]::HtmlDecode($text)

    # Normalize NBSP and whitespace
    $text = $text -replace [char]0x00A0, ' '
    $text = $text -replace "`r`n", "`n"
    $text = $text -replace "`r", "`n"

    # Trim trailing spaces
    $lines = $text -split "`n"
    $lines = $lines | ForEach-Object { $_.TrimEnd() }
    $text = ($lines -join "`n")

    # Collapse excessive blank lines
    $text = [regex]::Replace($text, "`n{3,}", "`n`n")

    return $text.Trim()
}

function Get-MailTimestamp {
    param($MailItem)

    # Prefer SentOn if available; fall back to ReceivedTime
    try {
        if ($MailItem.SentOn) { return [datetime]$MailItem.SentOn }
    } catch {}

    try {
        if ($MailItem.ReceivedTime) { return [datetime]$MailItem.ReceivedTime }
    } catch {}

    return [datetime]::MinValue
}

# ---------------------------
# Main
# ---------------------------

Add-Type -AssemblyName System.Web

$outlook = New-Object -ComObject Outlook.Application
$namespace = $outlook.GetNamespace("MAPI")
$explorer = $outlook.ActiveExplorer()

if ($null -eq $explorer) {
    throw "No active Outlook Explorer window was found."
}

$selection = $explorer.Selection
if ($selection.Count -lt 1) {
    throw "Please select a single email in Outlook before running this script."
}

$mail = $selection.Item(1)
if ($null -eq $mail) {
    throw "Unable to read the selected Outlook item."
}

# Get conversation
$conversation = $mail.GetConversation()
if ($null -eq $conversation) {
    throw "The selected email does not expose a conversation thread."
}

$table = $conversation.GetTable()
$messages = New-Object System.Collections.ArrayList

while (-not $table.EndOfTable) {
    $row = $table.GetNextRow()
    $entryId = $row["EntryID"]

    if ($entryId) {
        try {
            $item = $namespace.GetItemFromID($entryId)
            if ($item -and $item.MessageClass -like "IPM.Note*") {
                [void]$messages.Add($item)
            }
        } catch {
            # Ignore items that cannot be loaded
        }
    }
}

if ($messages.Count -eq 0) {
    throw "No mail messages were retrieved from the selected conversation."
}

# Sort chronologically
$messages = @($messages | Sort-Object { Get-MailTimestamp $_ })

# Determine latest timestamp and conversation subject
$mostRecent = $messages | Sort-Object { Get-MailTimestamp $_ } -Descending | Select-Object -First 1
$latestTimestamp = (Get-MailTimestamp $mostRecent).ToString("yyyyMMddHHmm")

$baseSubject = $mail.ConversationTopic
if ([string]::IsNullOrWhiteSpace($baseSubject)) {
    $baseSubject = $mail.Subject
}
$baseSubject = Get-SafeName -Name $baseSubject -MaxLength 100

$baseName = "{0}_{1}" -f $baseSubject, $latestTimestamp

$desktop = [Environment]::GetFolderPath("Desktop")

# Create / reference parent folder
$exportRoot = Join-Path $desktop "email-exports"
if (!(Test-Path $exportRoot)) {
    New-Item -ItemType Directory -Path $exportRoot | Out-Null
}

# Create this export folder inside it
$rootFolder = Join-Path $exportRoot $baseName
$rootFolder = Get-UniqueFilePath -Path $rootFolder

New-Item -ItemType Directory -Path $rootFolder | Out-Null

$attachmentsFolder = Join-Path $rootFolder "attachments"
New-Item -ItemType Directory -Path $attachmentsFolder | Out-Null

$markdownPath = Join-Path $rootFolder ($baseName + ".md")

# Accumulate markdown
$md = New-Object System.Text.StringBuilder

[void]$md.AppendLine("# $baseSubject")
[void]$md.AppendLine("")
[void]$md.AppendLine("- Exported from selected Outlook conversation")
[void]$md.AppendLine("- Latest message timestamp: $latestTimestamp")
[void]$md.AppendLine("- Message count: $($messages.Count)")
[void]$md.AppendLine("")

foreach ($msg in $messages) {
    $msgTimestamp = Get-MailTimestamp $msg
    $msgStampText = $msgTimestamp.ToString("yyyy-MM-dd HH:mm")

    [void]$md.AppendLine("---")
    [void]$md.AppendLine("")
    [void]$md.AppendLine("## $($msg.Subject)")
    [void]$md.AppendLine("")
    [void]$md.AppendLine("- **From:** $($msg.SenderName)")
    [void]$md.AppendLine("- **To:** $($msg.To)")
    if (-not [string]::IsNullOrWhiteSpace($msg.CC)) {
        [void]$md.AppendLine("- **CC:** $($msg.CC)")
    }
    [void]$md.AppendLine("- **Date:** $msgStampText")
    [void]$md.AppendLine("")

    # Save attachments for this message and get metadata
    $attachmentMetadata = @(Get-AttachmentMetadata -MailItem $msg -AttachmentsFolder $attachmentsFolder)

    # Convert HTML body to Markdown while preserving inline image placement
    $bodyHtml = $msg.HTMLBody
    $bodyMd = Convert-HtmlToMarkdown -Html $bodyHtml -AttachmentMetadata $attachmentMetadata

    if (-not [string]::IsNullOrWhiteSpace($bodyMd)) {
        [void]$md.AppendLine($bodyMd)
        [void]$md.AppendLine("")
    }

    # Add explicit attachment list for anything not already obvious inline
    if ($attachmentMetadata.Count -gt 0) {
        [void]$md.AppendLine("")
        [void]$md.AppendLine("**Attachments for this message:**")
        foreach ($a in $attachmentMetadata) {

            if ($null -eq $a) { continue }

            $isImage = $false
            if ($a.PSObject.Properties.Match('IsLikelyImage').Count -gt 0) {
                $isImage = [bool]$a.IsLikelyImage
            }

            if ($isImage) {
                [void]$md.AppendLine("- ![$($a.FileName)]($($a.RelativePath))")
            }
            else {
                [void]$md.AppendLine("- [$($a.FileName)]($($a.RelativePath))")
            }
        }
        [void]$md.AppendLine("")
    }
}
# Write markdown file
[System.IO.File]::WriteAllText($markdownPath, $md.ToString(), [System.Text.UTF8Encoding]::new($true))

Write-Host "Export complete." -ForegroundColor Green
Write-Host "Folder:      $rootFolder"
Write-Host "Markdown:    $markdownPath"
Write-Host "Attachments: $attachmentsFolder"