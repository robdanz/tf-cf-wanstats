variable "cloudflare_account_id" {
  description = "Your Cloudflare Account ID. Find at: Workers & Pages → Overview → right sidebar."
  type        = string
}

variable "cloudflare_api_token" {
  description = <<-EOT
    Cloudflare API token used by Terraform and Wrangler to deploy the worker and manage resources.
    Required permissions:
      - Account > D1 > Edit
      - Account > Workers Scripts > Edit
      - Account > Account Settings > Read
    Create at: https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom token.
  EOT
  type      = string
  sensitive = true
}

variable "wan_api_token" {
  description = <<-EOT
    Cloudflare API token used by the worker at runtime to query WAN tunnel analytics via the GraphQL API.
    Required permissions:
      - Account > Account Analytics > Read
    Create at: https://dash.cloudflare.com/profile/api-tokens → Create Token → Custom token.
    This is stored as a Worker secret (WAN_API_TOKEN) and never appears in wrangler.jsonc or logs.
  EOT
  type      = string
  sensitive = true
}
