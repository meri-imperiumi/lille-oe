ENV?=dev
ANSIBLE_ROLES_PATH=$(shell pwd)/roles:$(shell pwd)/roles/marinepi-provisioning/roles

roles/marinepi-provisioning:
	ansible-galaxy install -r requirements.yml -p roles

deploy: roles/marinepi-provisioning
	ansible-playbook -i hosts -l $(ENV) playbooks/lille-oe.yml --ask-vault-pass

backup:
	rsync -avzuh -e ssh "pi@192.168.1.105:/home/pi/.signalk/*" signalk

.PHONY: deploy backup
