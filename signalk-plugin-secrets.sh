#!/bin/bash
# Helper script to manage Signal K config encryption/decryption

set -e

PLUGIN_DIR="signalk/plugin-config-data"

# List of plugin configs containing secrets that should be encrypted
# Format: "subdir/filename"
SECRET_FILES=(
    "plugin-config-data/ais-forwarder.json"        # AIS endpoint configuration (boat-specific)
    "plugin-config-data/aisreporter.json"          # AIS reporter endpoints (boat-specific)
    "plugin-config-data/openweather.json"          # OpenWeather API key
    "plugin-config-data/signalk-windy-apiv2.json"  # Windy API key and station password
    "plugin-config-data/signalk-postgsail.json"    # PostGSail authentication token
    "plugin-config-data/@noforeignland-signalk-to-noforeignland.json"  # NoForeignLand boat API key
    "plugin-config-data/signalk-aprsfi-ais-reporter.json"  # APRS.fi API key
    "plugin-config-data/noflo-signalk.json"        # NoFlo secret and UUID
    "security.json"                                 # Signal K security (users, devices, secretKey)
)

# Get full path for a secret file
get_path() {
    local file="$1"
    if [[ "$file" == */* ]]; then
        echo "signalk/$file"
    else
        echo "signalk/$file"
    fi
}

# Get encrypted filename
get_encrypted_path() {
    local file="$1"
    local dirname=$(dirname "$file")
    local basename=$(basename "$file" .json)
    if [[ "$dirname" == "." ]]; then
        echo "signalk/${basename}.sops.json"
    else
        echo "signalk/${dirname}/${basename}.sops.json"
    fi
}

# Get cleartext filename
get_cleartext_path() {
    local file="$1"
    local dirname=$(dirname "$file")
    local basename=$(basename "$file" .json)
    if [[ "$dirname" == "." ]]; then
        echo "signalk/${basename}.json"
    else
        echo "signalk/${dirname}/${basename}.json"
    fi
}

# Usage info
usage() {
    echo "Usage: $0 <command>"
    echo ""
    echo "Commands:"
    echo "  encrypt     Encrypt cleartext configs to .sops.json"
    echo "  decrypt     Decrypt .sops.json configs to cleartext"
    echo "  list        List which configs are tracked for encryption"
    echo "  check       Check which configs need encryption/decryption"
    echo "  clean       Remove cleartext versions of encrypted configs"
}

# List tracked configs
list_configs() {
    echo "Configs tracked for SOPS encryption:"
    for file in "${SECRET_FILES[@]}"; do
        echo "  - $file"
    done
}

# Encrypt cleartext configs to SOPS
encrypt_configs() {
    echo "Encrypting configs..."
    for file in "${SECRET_FILES[@]}"; do
        cleartext=$(get_cleartext_path "$file")
        encrypted=$(get_encrypted_path "$file")

        if [ -f "$cleartext" ]; then
            if [ -f "$encrypted" ]; then
                # Decrypt existing and compare using hash
                if command -v md5sum &> /dev/null; then
                    # Linux: md5sum
                    decrypted_hash=$(sops --decrypt "$encrypted" 2>/dev/null | md5sum | cut -d' ' -f1)
                    cleartext_hash=$(md5sum "$cleartext" 2>/dev/null | cut -d' ' -f1)
                elif command -v md5 &> /dev/null; then
                    # macOS: md5
                    decrypted_hash=$(sops --decrypt "$encrypted" 2>/dev/null | md5 -q)
                    cleartext_hash=$(md5 -q "$cleartext")
                else
                    # Fallback: sha256sum (common on both)
                    decrypted_hash=$(sops --decrypt "$encrypted" 2>/dev/null | sha256sum | cut -d' ' -f1)
                    cleartext_hash=$(sha256sum "$cleartext" 2>/dev/null | cut -d' ' -f1)
                fi

                if [ "$decrypted_hash" = "$cleartext_hash" ]; then
                    echo "  ✓ $file (unchanged, skipping encryption)"
                    continue
                fi
            fi
            echo "  Encrypting $file..."
            sops --config /dev/null --pgp "39D337CCE31E2D75D6121959FF9EAEBA76E18617" --encrypt --input-type json --output-type json --output "$encrypted" "$cleartext"
        else
            echo "  Skipping $file (not found)"
        fi
    done
    echo "Encryption complete."
    echo "Run '$0 clean' to remove cleartext versions."
}

# Decrypt SOPS configs to cleartext
decrypt_configs() {
    echo "Decrypting configs..."
    for file in "${SECRET_FILES[@]}"; do
        cleartext=$(get_cleartext_path "$file")
        encrypted=$(get_encrypted_path "$file")

        if [ -f "$encrypted" ]; then
            echo "  Decrypting $file..."
            sops --decrypt "$encrypted" > "$cleartext"
        else
            echo "  Skipping $file (encrypted version not found)"
        fi
    done
    echo "Decryption complete."
}

# Check status
check_status() {
    echo "Checking encryption status..."
    for file in "${SECRET_FILES[@]}"; do
        cleartext=$(get_cleartext_path "$file")
        encrypted=$(get_encrypted_path "$file")

        if [ -f "$cleartext" ] && [ ! -f "$encrypted" ]; then
            echo "  ⚠ $file - cleartext exists, not encrypted"
        elif [ ! -f "$cleartext" ] && [ -f "$encrypted" ]; then
            echo "  ✓ $file - encrypted only"
        elif [ -f "$cleartext" ] && [ -f "$encrypted" ]; then
            echo "  ⚠ $file - both cleartext and encrypted exist"
        else
            echo "  ✗ $file - not found"
        fi
    done
}

# Clean cleartext versions
clean_cleartext() {
    echo "Removing cleartext versions of encrypted configs..."
    for file in "${SECRET_FILES[@]}"; do
        cleartext=$(get_cleartext_path "$file")
        encrypted=$(get_encrypted_path "$file")

        if [ -f "$cleartext" ] && [ -f "$encrypted" ]; then
            echo "  Removing $cleartext..."
            rm "$cleartext"
        fi
    done
    echo "Clean complete."
}

# Main
case "${1:-}" in
    encrypt)
        encrypt_configs
        ;;
    decrypt)
        decrypt_configs
        ;;
    list)
        list_configs
        ;;
    check)
        check_status
        ;;
    clean)
        clean_cleartext
        ;;
    *)
        usage
        exit 1
        ;;
esac