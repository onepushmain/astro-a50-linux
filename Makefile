PREFIX ?= /usr/local
DESTDIR ?=
UDEVDIR ?= $(PREFIX)/lib/udev/rules.d
SHARE = $(DESTDIR)$(PREFIX)/share
APP_FILES = $(shell find app -type f)

.PHONY: test install uninstall

test:
	node --test test/
	python3 -I -m unittest discover -s test -p 'test_*.py'

install:
	@for f in $(APP_FILES); do install -Dm644 "$$f" "$(SHARE)/astro-a50/$$f"; done
	install -Dm755 bin/astro-a50 "$(DESTDIR)$(PREFIX)/bin/astro-a50"
	install -Dm755 bin/astro-a50-status "$(DESTDIR)$(PREFIX)/bin/astro-a50-status"
	install -Dm644 packaging/70-astro-a50.rules "$(DESTDIR)$(UDEVDIR)/70-astro-a50.rules"
	install -Dm644 packaging/astro-a50.desktop "$(SHARE)/applications/astro-a50.desktop"
	install -Dm644 app/img/icon.svg "$(SHARE)/icons/hicolor/scalable/apps/astro-a50.svg"
	install -Dm644 LICENSE "$(SHARE)/licenses/astro-a50/LICENSE"

uninstall:
	rm -rf "$(SHARE)/astro-a50" "$(SHARE)/licenses/astro-a50"
	rm -f "$(DESTDIR)$(PREFIX)/bin/astro-a50" "$(DESTDIR)$(PREFIX)/bin/astro-a50-status" \
	  "$(DESTDIR)$(UDEVDIR)/70-astro-a50.rules" "$(SHARE)/applications/astro-a50.desktop" \
	  "$(SHARE)/icons/hicolor/scalable/apps/astro-a50.svg"
