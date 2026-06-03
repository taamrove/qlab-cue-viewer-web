# qlab-cue-viewer-web ops. Targets assume SSH to the Unraid host works as root.
# Run from this directory: `make deploy`, `make logs`, etc.

HOST       ?= root@10.10.20.201
REMOTE_DIR ?= /mnt/user/appdata/qlab-cue-viewer-web
HOST_PORT  ?= 8766
CONTAINER  ?= qlab-cue-viewer-web
IMAGE      ?= qlab-cue-viewer-web:latest

.PHONY: help deploy sync build logs stop

help:
	@echo "Targets:"
	@echo "  deploy   sync source, rebuild image on the server, restart container"
	@echo "  build    build the image locally (no deploy) for testing"
	@echo "  logs     tail container logs (Ctrl-C to stop)"
	@echo "  stop     stop & remove the container"

deploy: sync
	@ssh $(HOST) "cd $(REMOTE_DIR) && docker build -t $(IMAGE) . && docker rm -f $(CONTAINER) 2>/dev/null; docker run -d --name $(CONTAINER) --restart unless-stopped -p $(HOST_PORT):80 $(IMAGE)" && \
	  echo "✔ deployed $(CONTAINER) on $(HOST):$(HOST_PORT)"

build:
	@docker build -t $(IMAGE) .

sync:
	@rsync -az --delete \
	  --exclude node_modules --exclude .git --exclude dist \
	  --exclude .env --exclude .env.local --exclude .playwright-mcp \
	  --exclude '*.png' \
	  ./ $(HOST):$(REMOTE_DIR)/

logs:
	@ssh -t $(HOST) "docker logs -f --tail 50 $(CONTAINER)"

stop:
	@ssh $(HOST) "docker rm -f $(CONTAINER)" && echo "✔ stopped"
