# vim: set noexpandtab:
roles/marinepi-provisioning:
	ansible-galaxy install -r requirements.yml

signalk: roles/marinepi-provisioning
	ansible-playbook -i hosts -l lille-oe-pi playbooks/lille-oe.yml --vault-password-file secrets.pass --extra-vars "@secrets.yml"

nas: roles/marinepi-provisioning
	ansible-playbook -i hosts -l lille-oe-nas playbooks/nas.yml --vault-password-file secrets.pass --extra-vars "@secrets.yml"

infodisplay: roles/marinepi-provisioning
	ansible-playbook -i hosts -l infodisplay playbooks/infodisplay.yml --vault-password-file secrets.pass --extra-vars "@secrets.yml"

backup:
	rsync -avzuh -e ssh "pi@192.168.2.105:/home/pi/.signalk/*" signalk
#	scp "pi@192.168.2.105:/var/lib/grafana/grafana.db" .

influx:
#	ssh pi@lille-oe-pi.local 'influxd backup -portable /home/pi/backup'
	ssh pi@lille-oe-pi.local 'rsync -avzuh /home/pi/backup/$(shell date +"%Y%m%d")* pi@192.168.2.140:/mnt/backup/influxdb'

restore:
	rsync -avzuh -e ssh signalk/* "pi@192.168.2.105:/home/pi/.signalk/"
#	scp grafana.db "pi@192.168.2.105:/var/lib/grafana/"

.PHONY: backup influx restore signalk nas infodisplay
