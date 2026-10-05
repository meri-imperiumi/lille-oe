#!/usr/bin/env python3
from __future__ import (absolute_import, division, print_function)
import subprocess
import yaml
import os
from ansible.errors import AnsibleFilterError

def sops_decrypt(content):
    """Decrypt SOPS-encrypted content.

    If content is a file path, decrypt the file.
    If content is SOPS-encrypted YAML string, write to temp and decrypt.
    """
    import tempfile
    try:
        if isinstance(content, str):
            # Check if it's an existing file path
            if os.path.exists(content):
                result = subprocess.run(
                    ['sops', '--decrypt', content],
                    capture_output=True,
                    text=True,
                    check=True
                )
                return yaml.safe_load(result.stdout)
            else:
                # It's SOPS-encrypted content, write to temp file and decrypt
                with tempfile.NamedTemporaryFile(mode='w', suffix='.yml', delete=False) as f:
                    f.write(content)
                    temp_path = f.name
                try:
                    result = subprocess.run(
                        ['sops', '--decrypt', temp_path],
                        capture_output=True,
                        text=True,
                        check=True
                    )
                    return yaml.safe_load(result.stdout)
                finally:
                    os.unlink(temp_path)
        elif isinstance(content, dict):
            # Already decrypted, return as-is
            return content
        else:
            raise AnsibleFilterError("sops_decrypt expects a string file path or SOPS content")
    except subprocess.CalledProcessError as e:
        raise AnsibleFilterError(f"Failed to decrypt with sops: {e.stderr}")
    except Exception as e:
        raise AnsibleFilterError(f"Error decrypting with sops: {str(e)}")

def sops_decrypt_file(file_path):
    """Decrypt a SOPS-encrypted file and return its contents as a dict"""
    try:
        result = subprocess.run(
            ['sops', '--decrypt', file_path],
            capture_output=True,
            text=True,
            check=True
        )
        return yaml.safe_load(result.stdout)
    except subprocess.CalledProcessError as e:
        raise AnsibleFilterError(f"Failed to decrypt {file_path} with sops: {e.stderr}")
    except Exception as e:
        raise AnsibleFilterError(f"Error decrypting {file_path} with sops: {str(e)}")

class FilterModule(object):
    def filters(self):
        return {
            'sops_decrypt': sops_decrypt,
            'sops_decrypt_file': sops_decrypt_file,
        }