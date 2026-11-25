// Change a variable through a pointer.
void bump(int *p) {
    *p = *p + 1;
}

int main() {
    int n = 41;
    bump(&n);
    return n;
}
