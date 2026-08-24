#include <stddef.h>
#include <string.h>

#define BUF_SIZE 64

void load_first(char *out, const char *in) {
    char buf[BUF_SIZE];
    strcpy(buf, in);
    memcpy(out, buf, BUF_SIZE);
}

void load_second(char *out, const char *in) {
    char buf[BUF_SIZE];
    strcpy(buf, in);
    memcpy(out, buf, BUF_SIZE);
}
