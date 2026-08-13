# Varanny Role

This role configures a Raspberry Pi to run VARA HF modem with varanny remote control, integrating with the Chromium kiosk browser used on the infodisplay machine.

## What it does

1. **Adds the pi user to the dialout group** - Required for serial port access to the radio
2. **Installs dependencies for headless Wine** - Installs `xvfb` and `cabextract` for Wine/VB6 library registration
3. **Installs Pi-Apps** (if not already installed) - A lightweight app installer for Raspberry Pi
4. **Installs VARA HF via Pi-Apps** - The amateur radio HF modem software (takes 15-30 min on first run, uses xvfb for headless installation)
5. **Creates serial port symlink** - Maps `/dev/ttyUSB0` to Wine's `com1` device
6. **Deploys VARA wrapper script** - A script that:
   - Stops the Chromium kiosk browser when VARA starts
   - Starts VARA HF via Wine
   - Restarts the Chromium kiosk browser when VARA exits
7. **Deploys varanny.json configuration** - Configuration file for the varanny remote control daemon

## How it works

The wrapper script (`vara_wrapper.sh`) manages the browser/VARA switching:

1. When varanny needs to start VARA HF, it calls the wrapper script
2. The wrapper kills the Chromium kiosk process (`pkill -f chromium-browser`)
3. It waits 2 seconds for system resources to be freed
4. Starts VARA HF via Wine in the background
5. Waits for VARA to exit (either naturally or via SIGTERM from varanny)
6. Restarts Chromium with the same kiosk parameters

This ensures that the heavy VARA HF application doesn't conflict with the browser for system resources.

## Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `vara_user` | `{{ ansible_user_id }}` | User to run VARA as |
| `serial_port_device` | `/dev/ttyUSB0` | Serial device for radio connection |
| `varanny_port` | `8273` | Port for varanny daemon |
| `vara_name` | `"VARA HF"` | Name of the VARA modem |
| `vara_type` | `"hf"` | Type of VARA modem (hf/vhf) |
| `vara_cat_port` | `4532` | CAT port for radio control |

Note: `kiosk_url` is defined in the `infodisplay.yml` playbook and is required by the wrapper script to restart the browser.

## Usage

The role is included in the `infodisplay.yml` playbook:

```bash
make infodisplay
```

Or manually:

```bash
ansible-playbook -i hosts -l infodisplay playbooks/infodisplay.yml
```

## First run considerations

On the first run, the Pi-Apps installation and VARA HF installation can take a significant amount of time:
- Dependencies (xvfb, cabextract): ~1-2 minutes
- Pi-Apps: ~5-10 minutes
- VARA HF via Pi-Apps: ~15-30 minutes (includes compilation of Box86 and Wine setup)

These tasks use async operations with polling to avoid timeouts, and are idempotent (will be skipped on subsequent runs if already installed).

### Recovery from failed installation

If a previous VARA HF installation failed (e.g., due to missing display), clean up before re-running:

```bash
# SSH into infodisplay and clean up the broken Wine prefix
ssh pi@infodisplay
rm -rf ~/.wine
~/pi-apps/manage uninstall "VARA HF" 2>/dev/null || true
exit

# Then re-run the playbook
make infodisplay
```

## Post-installation

After running the playbook, you'll need to:

1. Ensure the radio's USB serial cable is connected to `/dev/ttyUSB0`
2. Start the varanny daemon (this is outside the scope of this playbook)
3. Configure varanny to connect to your radio control software as needed

## Hardware requirements

- Raspberry Pi 4 (or equivalent)
- USB serial cable for radio connection
- Sufficient RAM and CPU for VARA HF + Wine (Box86 provides x86 emulation on ARM)