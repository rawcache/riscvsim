// Count down in C++.
int main() {
    int n = 5;
    bool done = false;
    while (!done) {
        n = n - 1;
        done = n == 0;
    }
    return n;
}
