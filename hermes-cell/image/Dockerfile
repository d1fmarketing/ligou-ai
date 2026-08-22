ARG HERMES_BASE_IMAGE
FROM ${HERMES_BASE_IMAGE}

LABEL org.opencontainers.image.title="Ligou Hermes auth-isolated runtime" \
      org.opencontainers.image.description="Hermes with a fail-closed HERMES_AUTH_HOME outside cognitive state"

COPY --chown=root:root --chmod=0755 patch-auth-home.py /tmp/patch-auth-home.py
RUN python3 /tmp/patch-auth-home.py && \
    rm -f /tmp/patch-auth-home.py && \
    install -d -o hermes -g hermes -m 0700 /opt/model-auth && \
    python3 -m py_compile /opt/hermes/hermes_cli/auth.py
