# Keep externally managed skills out of the repo

Track only me-pi-owned skills here. Matt Pocock skills installed and updated globally remain external copies in `~/.agents/skills`; don't vendor duplicate names or customized upstream copies, which create competing sources of truth. `install.sh` links repo-owned skills individually and leaves external entries untouched.
