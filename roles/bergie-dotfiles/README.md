# bergie-dotfiles Ansible Role

This Ansible role installs and configures bergie's dotfiles, including fish shell and neovim setup.

## Requirements

- Ansible 2.9+
- Target system running Debian or Ubuntu
- `become` privileges (for installing packages and changing the default shell)

## Role Variables

Available variables are listed below, along with default values (see `defaults/main.yml`):

```yaml
# Repository URL for the dotfiles
dotfiles_repo: https://github.com/bergie/dotfiles.git

# Whether to set fish as the default shell (requires logout/login)
set_default_shell: true
```

## Dependencies

None.

## Example Playbook

```yaml
---
- name: Install bergie dotfiles
  hosts: servers
  become: yes

  roles:
    - role: bergie-dotfiles
      vars:
        dotfiles_user: bergie
        set_default_shell: true
```

## What gets installed

This role will:

1. Install required packages:
   - fish (shell)
   - neovim (text editor)
   - stow (for managing dotfiles)
   - git (for version control)
   - curl and build-essential (dependencies)

2. Clone the dotfiles repository to `~<user>/dotfiles`

3. Initialize git submodules (including neovim plugins)

4. Use GNU Stow to deploy:
   - Fish shell configuration
   - Neovim configuration (including TokyoNight theme)

5. Set fish as the default shell (optional, controlled by `set_default_shell`)

## Note on Default Shell

After changing the default shell to fish, you'll need to log out and log back in for the change to take effect.

## Dotfiles Structure

The dotfiles include:
- **fish**: Fish shell configuration with useful aliases and functions
- **nvim**: Neovim configuration with LSP support for TypeScript/JavaScript
- **git**: Git configuration
- TokyoNight Neovim theme (via git submodule)