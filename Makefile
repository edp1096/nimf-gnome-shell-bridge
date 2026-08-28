CC ?= cc
PKG_CONFIG ?= pkg-config

CPPFLAGS += -Iinclude $(shell $(PKG_CONFIG) --cflags gio-unix-2.0 gio-2.0 glib-2.0)
CFLAGS ?= -O2 -g
CFLAGS += -std=c11 -Wall -Wextra -Werror
LDLIBS += $(shell $(PKG_CONFIG) --libs gio-unix-2.0 gio-2.0 glib-2.0) -lnimf

BUILD_DIR := build
TARGET := $(BUILD_DIR)/nimf-shell-bridge
SOURCE := src/nimf-shell-bridge.c
HEADER := include/nimf-legacy.h

.PHONY: all clean check

all: $(TARGET)

$(TARGET): $(SOURCE) $(HEADER) | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS) $(SOURCE) -o $@ $(LDFLAGS) $(LDLIBS)

$(BUILD_DIR):
	mkdir -p $@

check: $(TARGET)
	$(TARGET) --check

clean:
	rm -f $(TARGET)
