CC      ?= gcc
CFLAGS  ?= -O2 -g
CFLAGS  += -std=gnu17 -Wall -Wextra -Wno-unused-parameter \
           -D_FORTIFY_SOURCE=3 -fstack-protector-strong -fPIE \
           $(shell pkg-config --cflags gtk4)
LDFLAGS += -pie -Wl,-z,relro,-z,now,--as-needed
LDLIBS  += $(shell pkg-config --libs gtk4) -lm
PREFIX  ?= $(HOME)/.local

pick: pick.c
	$(CC) $(CFLAGS) $(LDFLAGS) -o $@ $< $(LDLIBS)

install: pick
	install -Dm755 pick $(PREFIX)/bin/pick
	install -Dm644 com.ahmadcodes.Pick.desktop $(PREFIX)/share/applications/com.ahmadcodes.Pick.desktop

clean:
	rm -f pick

.PHONY: install clean
