# Wrapper for hactl: show a clear error when the CLI is used before the
# add-on has written an instance config (/data/hactl/.env is created at
# add-on start from the 'access_token' option), instead of letting hactl
# fail with a cryptic connection error. Offline commands stay available.
hactl() {
    case "$1" in
        rtfm|version|help|--help|-h)
            ;;
        *)
            if [ ! -f /data/hactl/.env ]; then
                echo "Error: hactl has no instance config (/data/hactl/.env missing)." >&2
                echo "" >&2
                echo "To configure:" >&2
                echo "  1. Go to your Home Assistant Profile page (click your user icon)" >&2
                echo "  2. Scroll to Long-lived Access Tokens and create one (owner account)" >&2
                echo "  3. Go to Settings -> Add-ons -> OpenCode -> Configuration" >&2
                echo "  4. Paste the token into the 'Home Assistant access token' field" >&2
                echo "  5. Restart the OpenCode add-on" >&2
                return 1
            fi
            ;;
    esac
    command hactl "$@"
}
