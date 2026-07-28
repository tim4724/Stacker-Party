# R8 keep rules for the release build.
# OkHttp, Media3, Compose, kotlinx-coroutines and Zipline ship their own consumer rules;
# we only need WebRTC and kotlinx.serialization here.

# ---- WebRTC: org.webrtc + the jni_zero JNI glue ----
# libjingle_peerconnection_so.so registers natives and FindClass()es these Java
# classes from its JNI_OnLoad — references R8 can't see, so it strips them and the
# native load aborts (ClassNotFoundException: org.jni_zero.JniInit -> SIGTRAP on the
# fastlane thread). Keep both packages intact. The AAR ships no consumer rules.
-keep class org.webrtc.** { *; }
-keep class org.jni_zero.** { *; }
-dontwarn org.webrtc.**
-dontwarn org.jni_zero.**

# ---- JNI: anything reached from native code by name ----
# The QuickJS binding (Zipline) ships consumer rules for the classes its libquickjs
# FindClass()es — QuickJsException, InterruptHandler, CallChannel — so there is no keep
# for it here. This rule is the general one: a class whose natives were renamed can no
# longer be bound at registration time.
-keepclasseswithmembernames class * {
    native <methods>;
}

# ---- kotlinx.serialization ----
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**

# Keep generated serializers and the serializer() lookups everywhere.
-keep,includedescriptorclasses class **$$serializer { *; }
-keepclassmembers @kotlinx.serialization.Serializable class ** {
    *** Companion;
    *** INSTANCE;
}
-keepclasseswithmembers class ** {
    kotlinx.serialization.KSerializer serializer(...);
}

# The engine snapshot / frame / command / net-envelope models are @Serializable
# and decoded from JSON the QuickJS engine emits, so keep them intact.
-keep class com.hexstacker.core.model.** { *; }
-keep class com.hexstacker.core.net.** { *; }

# ---- kotlinx-coroutines: keep the atomic field updaters (belt-and-suspenders) ----
-keepclassmembers class kotlinx.coroutines.** {
    volatile <fields>;
}
-dontwarn kotlinx.coroutines.**
