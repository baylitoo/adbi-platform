# PostgreSQL 17 Alpine + pgvector, compilé sur la même base musl : les données existantes restent lisibles sans REINDEX.
FROM postgres:17-alpine
ARG PGVECTOR_VERSION=v0.8.0
RUN apk add --no-cache --virtual .construction git build-base \
 && git clone --branch "$PGVECTOR_VERSION" --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
 && make -C /tmp/pgvector with_llvm=no OPTFLAGS="" \
 && make -C /tmp/pgvector install with_llvm=no \
 && rm -rf /tmp/pgvector \
 && apk del .construction
