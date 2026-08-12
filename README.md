# Lille Oe server setup

## Secrets management

We're using SOPS with GPG encryption. To edit secrets:
```bash
sops playbooks/secrets.nas.yml
```
To view decrypted secrets:
```bash
sops --decrypt playbooks/secrets.nas.yml
```

### Adding new Signal K configs to encrypt

 1. Edit the script to add the file:
 ```bash
   # Edit signalk-plugin-secrets.sh
   # Add the filename to the SECRET_PLUGINS array:
   SECRET_PLUGINS=(
       "ais-forwarder.json"
       "aisreporter.json"
       "openweather.json"
       "signalk-windy.json"
       "signalk-postgsail.json"
       "signalk-to-noforeignland.json"
       "noflo-signalk.json"
       "your-new-file.json"    # ← Add here
   )
 ```

 2. Add to .gitignore (if not already):
 ```bash
   echo "signalk/plugin-config-data/your-new-file.json" >> .gitignore
 ```

 3. Run make backup to fetch and encrypt:
 ```bash
   make backup
 ```
