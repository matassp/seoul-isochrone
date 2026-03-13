FROM eclipse-temurin:21-jre

WORKDIR /app

# Download GraphHopper 9.1 JAR
RUN apt-get update -qq && apt-get install -y -qq curl && \
    curl -L -o graphhopper.jar \
    https://github.com/graphhopper/graphhopper/releases/download/9.1/graphhopper-web-9.1.jar && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

EXPOSE 8989

ENTRYPOINT ["java", "-jar", "/app/graphhopper.jar"]
CMD ["server", "/data/config.yml"]
