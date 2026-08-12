# vim: set noexpandtab:
roles/marinepi-provisioning:
	ansible-galaxy install -r requirements.yml

signalk: roles/marinepi-provisioning
	ansible-playbook -i hosts -l lille-oe-pi playbooks/lille-oe.yml

nas: roles/marinepi-provisioning
	ansible-playbook -i hosts -l lille-oe-nas playbooks/nas.yml

infodisplay: roles/marinepi-provisioning
	ansible-playbook -i hosts -l infodisplay playbooks/infodisplay.yml

cloud: roles/marinepi-provisioning
	ansible-playbook -i hosts -l cloud playbooks/cloud.yml

backup:
	rsync -avzuh --exclude 'node_modules' --exclude 'charts' -e ssh "pi@192.168.2.105:/home/pi/.signalk/*" signalk
	./signalk-plugin-secrets.sh encrypt
#	scp "pi@192.168.2.105:/var/lib/grafana/grafana.db" .

influx:
	ssh pi@lille-oe-pi.local 'influxd backup -portable /home/pi/backup'
	ssh pi@lille-oe-pi.local 'rsync -avzuh /home/pi/backup/$(date +"%Y%m%d")* pi@192.168.2.140:/mnt/backup/influxdb'

restore:
	./signalk-plugin-secrets.sh decrypt
	rsync -avzuh -e ssh signalk/* "pi@192.168.2.105:/home/pi/.signalk/"
#	scp grafana.db "pi@192.168.2.105:/var/lib/grafana/"

# Signal K plugin secret management
plugin-secrets-encrypt:
	./signalk-plugin-secrets.sh encrypt

plugin-secrets-decrypt:
	./signalk-plugin-secrets.sh decrypt

plugin-secrets-clean:
	./signalk-plugin-secrets.sh clean

plugin-secrets-check:
	./signalk-plugin-secrets.sh check

.PHONY: backup influx restore signalk nas infodisplay cloud plugin-secrets-encrypt plugin-secrets-decrypt plugin-secrets-clean plugin-secrets-check
