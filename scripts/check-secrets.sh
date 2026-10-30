#!/usr/bin/env bash
# Fail when a tracked file holds something that looks like a credential: a PEM
# private key, a GitHub token, a Discord webhook URL, or a value assigned to a
# credential or owner identifier that is not a known placeholder. Every tracked
# file is checked, tests and docs included. Findings name the file, line and
# rule, never the value.
#
# This catches labelled and recognizable leaks only. An unlabelled random string
# still needs a reviewer's eye.
#
# Usage: scripts/check-secrets.sh   (from anywhere inside the repository)
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# The Perl program is single-quoted on purpose: the shell must not expand it.
# shellcheck disable=SC2016
git ls-files -z | xargs -0 perl -e '
use strict;
use warnings;

# Set only with `wrangler secret put`, never committed (credentials and owner identifiers).
my $names = qr/(?:GITHUB_APP_PRIVATE_KEY|GITHUB_WEBHOOK_SECRET|ADMIN_API_TOKEN|DISCORD_WEBHOOK_URL|GITHUB_PUBLIC_TOKEN|GITHUB_TOKEN|GITHUB_APP_INSTALLATION_ID|GITHUB_APP_ID|DISCORD_APPLICATION_ID|DISCORD_PUBLIC_KEY|DISCORD_ALLOWED_USER_IDS|PEOPLE_IGNORED_LOGINS)/;

# The one Discord webhook URL tests may use.
my $fixture_webhook = "https://discord.com/api/webhooks/0/test-only";

sub is_placeholder {
  my ($value) = @_;
  return 1 if $value eq "";
  return 1 if $value =~ /^replace-with-/;    # .dev.vars.example
  return 1 if $value =~ /<[A-Za-z0-9_.-]+>/;  # <your-worker>, <id>/<token>
  return 1 if $value =~ /^\$/;               # $VARIABLE, ${expression}
  return 1 if $value =~ /^test-/;            # test fixtures
  return 1 if $value eq "admin-token";       # vitest.workers.config.ts
  return 1 if $value eq $fixture_webhook;
  return 0;
}

my $failed = 0;
sub report {
  my ($file, $line, $rule) = @_;
  print STDERR "$file:$line: $rule\n";
  $failed = 1;
}

for my $file (@ARGV) {
  next if -l $file || !-f $file || -B $file;
  open(my $handle, "<", $file) or die "cannot read $file: $!\n";
  my $is_code = $file =~ /\.(?:[cm]?[jt]s|tsx)$/;
  my $pem_header_line = 0;
  while (my $text = <$handle>) {
    my $line = $.;
    if ($pem_header_line && $text =~ /^\s*[A-Za-z0-9+\/=]{40,}\s*$/) {
      report($file, $pem_header_line, "PEM private key");
    }
    $pem_header_line = 0;
    if ($text =~ /-----BEGIN [A-Z ]*PRIVATE KEY-----/) {
      if ($text =~ /PRIVATE KEY-----(?:\\n|\s)*[A-Za-z0-9+\/]{40,}/) {
        report($file, $line, "PEM private key");
      } else {
        $pem_header_line = $line;
      }
    }
    if ($text =~ /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/) {
      report($file, $line, "GitHub token");
    }
    while ($text =~ m{(https://(?:[a-z]+\.)?discord(?:app)?\.com/api/(?:v\d+/)?webhooks/[0-9]+/[A-Za-z0-9._-]+)}g) {
      report($file, $line, "Discord webhook URL") unless $1 eq $fixture_webhook;
    }
    if ($file eq "wrangler.jsonc" && $text =~ /$names/) {
      report($file, $line, "credential or owner identifier in wrangler.jsonc; use wrangler secret put");
    }
    while ($text =~ /(?<![A-Za-z0-9_])($names)["\x27`]?\s*[:=]\s*("(?:[^"\\]|\\.)*"|\x27(?:[^\x27\\]|\\.)*\x27|`[^`]*`|[^\s,;)}\]]*)/g) {
      my ($name, $value) = ($1, $2);
      my $quoted = $value =~ s/^(["\x27`])(.*)\1$/$2/s;
      # In code, an unquoted value is an expression, not a literal.
      next if !$quoted && ($is_code || $value =~ /^[{\[(]/);
      report($file, $line, "$name is assigned a value that is not a placeholder")
        unless is_placeholder($value);
    }
  }
  close($handle);
}
exit $failed;
'
