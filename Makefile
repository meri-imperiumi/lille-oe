ENV?=dev

roles/marinepi-provisioning:
	ansible-galaxy install -r requirements.yml -p roles

signalk: roles/marinepi-provisioning
	ansible-playbook -i hosts -l $(ENV) playbooks/lille-oe.yml --ask-vault-pass

navstation:
	ansible-playbook -i hosts -l navstation playbooks/navstation.yml

backup:
	rsync -avzuh -e ssh "pi@192.168.1.105:/home/pi/.signalk/*" signalk

.PHONY: deploy backup
