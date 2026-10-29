UUID    := clip@ahmadcodes.com
SCHEMA  := org.gnome.shell.extensions.clip.gschema.xml
VERSION := $(shell sed -n 's/.*"version": *\([0-9]*\).*/\1/p' $(UUID)/metadata.json)

all: build pick/pick

# Clip is written in TypeScript (src/); tsc writes readable JavaScript next to
# metadata.json, which is what GNOME Shell loads and extensions.gnome.org reviews.
build: node_modules
	npx tsc

node_modules: package.json package-lock.json
	npm ci --no-audit --no-fund
	@touch node_modules

pick/pick: pick/pick.c
	$(MAKE) -C pick

install:
	./install.sh

uninstall:
	./uninstall.sh

# Static checks that need no running GNOME session.
check: build pick/pick
	glib-compile-schemas --strict --dry-run $(UUID)/schemas
	@for f in $(UUID)/extension.js $(UUID)/prefs.js; do \
	  cp $$f /tmp/desktop-tools-check.mjs && node --check /tmp/desktop-tools-check.mjs && echo "ok $$f"; \
	done; rm -f /tmp/desktop-tools-check.mjs
	bash -n install.sh uninstall.sh

# dist/clip@ahmadcodes.com.shell-extension.zip  (for extensions.gnome.org or gnome-extensions install)
# dist/desktop-tools-$(VERSION).tar.gz          (source release, needs a git commit)
dist: build
	mkdir -p dist
	gnome-extensions pack --force --out-dir=dist --schema=schemas/$(SCHEMA) --extra-source=prefs.js $(UUID)
	git archive --prefix=desktop-tools-$(VERSION)/ -o dist/desktop-tools-$(VERSION).tar.gz HEAD
	@ls -l dist

# Try the extension in a nested GNOME Shell window without logging out.
devkit:
	./install.sh
	dbus-run-session -- gnome-shell --devkit --wayland

clean:
	$(MAKE) -C pick clean
	rm -rf dist $(UUID)/extension.js $(UUID)/prefs.js

.PHONY: all build install uninstall check dist devkit clean
