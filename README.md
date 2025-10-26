# README

This README would normally document whatever steps are necessary to get the
application up and running.

Things you may want to cover:

* Ruby version

* System dependencies

* Configuration

* Database creation

* Database initialization

* How to run the test suite

* Services (job queues, cache servers, search engines, etc.)

* Deployment instructions

* ...


kamal proxy boot_config set \
  --publish false \
  --docker_options label=traefik.http.services.kamal_proxy.loadbalancer.server.scheme=http \
                   label=traefik.http.routers.kamal_proxy.rule="Host(\\\`pickem.unboundops.com\\\`)" \
                   label=traefik.enable=true \
                   label=traefik.http.routers.kamal_proxy.entrypoints=websecure \
                   label=traefik.http.routers.kamal_proxy.tls=true \
                   label=traefik.http.routers.kamal_proxy.tls.certresolver=mytlschallenge \
                   label=traefik.http.middlewares.kamal_proxy.headers.SSLHost="unboundops.com" \
                   label=traefik.http.middlewares.kamal_proxy.headers.SSLRedirect=true \
                   label=traefik.http.middlewares.kamal_proxy.headers.STSIncludeSubdomains=true \
                   label=traefik.http.middlewares.kamal_proxy.headers.STSPreload=true \
                   label=traefik.http.middlewares.kamal_proxy.headers.STSSeconds=315360000 \
                   label=traefik.http.middlewares.kamal_proxy.headers.browserXSSFilter=true \
                   label=traefik.http.middlewares.kamal_proxy.headers.contentTypeNosniff=true \
                   label=traefik.http.middlewares.kamal_proxy.headers.forceSTSHeader=true
