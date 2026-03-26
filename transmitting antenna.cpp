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
    while(true) delay(1000);
  }

  Serial.println("TX ready");
}

void loop() {
  int state = radio.transmit("A");
  Serial.print("TX: ");
  Serial.println(state);
  delay(10);
}