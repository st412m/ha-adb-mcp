ARG BUILD_FROM
FROM ${BUILD_FROM}

RUN apk add --no-cache nodejs android-tools imagemagick

COPY run.sh /run.sh
COPY proxy.js /proxy.js
COPY server.js /server.js
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
