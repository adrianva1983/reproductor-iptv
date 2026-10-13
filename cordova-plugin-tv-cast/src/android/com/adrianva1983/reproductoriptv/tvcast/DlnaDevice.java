package com.adrianva1983.reproductoriptv.tvcast;

/** Dispositivo DLNA/UPnP (MediaRenderer) encontrado por SSDP. */
public class DlnaDevice {
    public final String id;
    public final String name;
    public final String controlUrl;

    public DlnaDevice(String id, String name, String controlUrl) {
        this.id = id;
        this.name = name;
        this.controlUrl = controlUrl;
    }
}
