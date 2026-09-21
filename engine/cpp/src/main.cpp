

#include <iostream>
#include <string>
using namespace std;


int main(){
    string line;
    while(getline(cin,line)){
        if(line=="uci"){
            //uci handshake
            cout<<"id name ChessWhisper Engine\n";
            cout<<"id author Uziel & Tamir\n";
            cout << "uciok\n";
            cout.flush();
        } else if (line == "quit") {
            break;
        }
        // Every other command (isready, position, go, ...) is ignored for
        // now — those arrive with the real UCI loop in CW-81/CW-82.
    }
    return 0;
}
