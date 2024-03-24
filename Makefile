ENV?=dev

roles/marinepi-provisioning:
	ansible-galaxy install -r requirements.yml

signalk: roles/marinepi-provisioning
	ansible-playbook -i hosts -l $(ENV) playbooks/lille-oe.yml --ask-vault-pass

navstation: roles/marinepi-provisioning
	ansible-playbook -i hosts -l navstation playbooks/navstation.yml

backup:
	rsync -avzuh -e ssh "pi@192.168.2.105:/home/pi/.signalk/*" signalk

restore:
	rsync -avzuh -e ssh signalk/* "pi@192.168.2.131:/home/pi/.signalk/"

.PHONY: backup restore signalk navstation
