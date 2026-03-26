#include <Arduino.h>
#include <SPI.h>
#include <RadioLib.h>

RF69 radio = new Module(14, 26, 27);

void setup() {
  Serial.begin(115200);
  delay(1000);

  SPI.begin(18, 19, 23, 14);

  int state = radio.begin(433.0, 4.8, 5.0, 125.0, 10, 16);
  Serial.print("begin: ");
  Serial.println(state);

  if(state != RADIOLIB_ERR_NONE) {
    while(true) delay(100);
  }

  Serial.println("RX ready");
}

void loop() {
  String msg;
  int state = radio.receive(msg);

  if(state == RADIOLIB_ERR_NONE) {
    Serial.print("Received: ");
    Serial.println(msg);
    Serial.print("RSSI: ");
    Serial.println(radio.getRSSI());
  } else if(state == RADIOLIB_ERR_RX_TIMEOUT) {
    Serial.println("Timeout");
  } else {
    Serial.print("RX error: ");
    Serial.println(state);
  }
}